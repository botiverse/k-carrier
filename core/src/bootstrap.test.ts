// @invariant — first adoption must create a real rollback target before any
// service handover; a complete stable slot is the only spendable proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapStable, BootstrapError, slotArtifactPath } from "./bootstrap.ts";
import { createUpgrader, type CreateUpgraderOptions } from "./createUpgrader.ts";
import type { HostAdapter, ProcessEvidence, Slot } from "./lifecycle/hostAdapter.ts";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "k-bootstrap-"));
}

test("bootstrapStable atomically seeds exact trusted bytes and is idempotent once initialized", async () => {
  const root = await tempDir();
  const stateDir = path.join(root, "state");
  const source = path.join(root, "current.bin");
  const bytes = Buffer.from("trusted-current-bytes");
  await fs.writeFile(source, bytes);

  assert.equal(await bootstrapStable({ stateDir, version: "1.0.0", artifactPath: source }), "bootstrapped");
  assert.deepEqual(await fs.readFile(slotArtifactPath(stateDir, "stable")), bytes);
  assert.equal(await fs.readFile(path.join(stateDir, "slots", "stable", "VERSION"), "utf8"), "1.0.0");

  // A later invocation may come from the old carrier path after K already
  // promoted a newer stable. Initialization must not reread or overwrite it.
  await fs.rm(source);
  assert.equal(
    await bootstrapStable({ stateDir, version: "1.0.0", artifactPath: source }),
    "already-initialized",
  );
  assert.deepEqual(await fs.readFile(slotArtifactPath(stateDir, "stable")), bytes);
});

test("bootstrapStable refuses partial stable or pre-existing transaction evidence", async () => {
  for (const kind of ["partial-stable", "journal", "experiment"] as const) {
    const root = await tempDir();
    const stateDir = path.join(root, "state");
    const source = path.join(root, "current.bin");
    await fs.writeFile(source, "trusted");
    if (kind === "partial-stable") {
      await fs.mkdir(path.join(stateDir, "slots", "stable"), { recursive: true });
      await fs.writeFile(slotArtifactPath(stateDir, "stable"), "partial");
    } else if (kind === "journal") {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(path.join(stateDir, "journal.jsonl"), "");
    } else {
      await fs.mkdir(path.join(stateDir, "slots", "experiment"), { recursive: true });
    }

    await assert.rejects(
      () => bootstrapStable({ stateDir, version: "1.0.0", artifactPath: source }),
      (error: unknown) => {
        assert.ok(error instanceof BootstrapError);
        assert.equal(error.code, "BOOTSTRAP_STATE_CONFLICT");
        return true;
      },
    );
  }
});

test("a failed first service upgrade restores the bootstrapped stable executable", async () => {
  const root = await tempDir();
  const stateDir = path.join(root, "state");
  const current = path.join(root, "current.bin");
  const currentBytes = Buffer.from("current-v1");
  const candidateBytes = Buffer.from("candidate-v2");
  await fs.writeFile(current, currentBytes);
  await bootstrapStable({ stateDir, version: "1.0.0", artifactPath: current });

  let liveVersion = "1.0.0";
  const starts: Slot[] = [];
  const host: HostAdapter = {
    async quiesce() {},
    async stop() {},
    async start(slot) {
      starts.push(slot);
      liveVersion = (await fs.readFile(path.join(stateDir, "slots", slot, "VERSION"), "utf8")).trim();
    },
    async healthProbe(): Promise<ProcessEvidence> {
      // The candidate starts but fails semantic readback, forcing rollback.
      return { version: liveVersion === "2.0.0" ? "2.0.0-broken" : liveVersion, pid: 7, startId: liveVersion };
    },
    async resume() {},
  };
  const release = {
    version: "2.0.0",
    url: `data:application/octet-stream;base64,${candidateBytes.toString("base64")}`,
    sha256: createHash("sha256").update(candidateBytes).digest("hex"),
    size: candidateBytes.length,
  };
  const opts: CreateUpgraderOptions = {
    stateDir,
    host,
    source: {
      checkForUpdate: async () => release,
      fetchRelease: async () => release,
    },
    policy: "auto",
    notificationSink: async () => {},
  };

  const outcome = await createUpgrader(opts).upgrade();
  assert.equal(outcome.result, "rolled-back");
  assert.deepEqual(starts, ["experiment", "stable"]);
  assert.equal(liveVersion, "1.0.0");
  assert.deepEqual(await fs.readFile(slotArtifactPath(stateDir, "stable")), currentBytes);
  await assert.rejects(() => fs.stat(slotArtifactPath(stateDir, "experiment")));
});
