// @invariant — the facade's gate ORDER is the contract: nothing touches disk
// before consent, ownership, and compatibility have each had their say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import http from "node:http";
import { createUpgrader, type CreateUpgraderOptions } from "./createUpgrader.ts";
import type { ReleaseSource } from "./artifact/source.ts";
import type { HostAdapter, ProcessEvidence, Slot } from "./lifecycle/hostAdapter.ts";
import { persistOperation } from "./operation.ts";

const BYTES = new TextEncoder().encode("#!/bin/sh\necho 2.0.0\n");
const SHA = createHash("sha256").update(BYTES).digest("hex");

async function stateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "k-facade-"));
}

/** A source serving one release over a local file:// URL. */
function sourceServing(version: string, url: string): ReleaseSource {
  const release = { version, url, sha256: SHA, size: BYTES.length };
  return {
    checkForUpdate: async (ctx) => (ctx.currentVersion === version ? null : release),
    fetchRelease: async (v) => {
      if (v !== version) throw new Error(`this source only serves ${version}`);
      return release;
    },
  };
}

function recordingHost(): HostAdapter & { calls: string[]; version: string } {
  const h = {
    calls: [] as string[],
    version: "1.0.0",
    async quiesce() { h.calls.push("quiesce"); },
    async stop(slot: Slot) { h.calls.push(`stop:${slot}`); },
    async start(slot: Slot) {
      h.calls.push(`start:${slot}`);
      if (slot === "experiment") h.version = "2.0.0";
    },
    async healthProbe(): Promise<ProcessEvidence> {
      h.calls.push("probe");
      return { version: h.version, pid: 1, startId: "s1" };
    },
    async resume() { h.calls.push("resume"); },
  };
  return h;
}

async function serveBytes(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k-serve-"));
  const file = path.join(dir, "app.bin");
  await fs.writeFile(file, BYTES);
  return `file://${file}`;
}

async function serveDownload(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, response) => {
    response.writeHead(200, {
      "content-length": String(BYTES.length),
      "content-type": "application/octet-stream",
    });
    response.end(BYTES);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return {
    url: `http://127.0.0.1:${address.port}/app.bin`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

async function baseOpts(dir: string, url: string): Promise<CreateUpgraderOptions> {
  const host = recordingHost();
  return {
    host,
    source: sourceServing("2.0.0", url),
    policy: "auto",
    notificationSink: async () => {},
    stateDir: dir,
  };
}

test("policy=confirm holds BEFORE any disk side effect", async () => {
  const dir = await stateDir();
  const opts = { ...(await baseOpts(dir, await serveBytes())), policy: "confirm" as const };
  const outcome = await createUpgrader(opts).upgrade();
  assert.equal(outcome.result, "held");
  // nothing staged: no slots directory was created at all
  await assert.rejects(() => fs.stat(path.join(dir, "slots", "experiment")));
});

test("a managed-elsewhere install refuses without consulting the source", async () => {
  const dir = await stateDir();
  let sourceConsulted = false;
  const opts: CreateUpgraderOptions = {
    ...(await baseOpts(dir, await serveBytes())),
    installOwnership: () => "managed-elsewhere",
    source: {
      checkForUpdate: async () => { sourceConsulted = true; return null; },
      fetchRelease: async () => { sourceConsulted = true; throw new Error("unreachable"); },
    },
  };
  const outcome = await createUpgrader(opts).upgrade();
  assert.equal(outcome.result, "held");
  assert.match((outcome as { reason: string }).reason, /managed by another manager/u);
  assert.equal(sourceConsulted, false, "ownership must short-circuit before the source is asked");
});

test("checkCompatibility refuses before staging, and its reason survives", async () => {
  const dir = await stateDir();
  const opts: CreateUpgraderOptions = {
    ...(await baseOpts(dir, await serveBytes())),
    checkCompatibility: async () => "no down-migration for schema 7",
  };
  const outcome = await createUpgrader(opts).upgrade();
  assert.equal(outcome.result, "held");
  assert.match((outcome as { reason: string }).reason, /no down-migration for schema 7/u);
  await assert.rejects(() => fs.stat(path.join(dir, "slots", "experiment")));
});

test("a second concurrent upgrade is refused while the first holds the lock", async () => {
  const dir = await stateDir();
  const opts = await baseOpts(dir, await serveBytes());
  // Hold the lock by hand, then attempt an upgrade.
  const { acquireUpgradeLock } = await import("./txn/lock.ts");
  const held = await acquireUpgradeLock(dir, 1);
  await assert.rejects(() => createUpgrader(opts).upgrade(), /UPGRADE_IN_PROGRESS/u);
  await held.release();
});

test("check() reports the target without changing anything", async () => {
  const dir = await stateDir();
  const opts = await baseOpts(dir, await serveBytes());
  const { current, target } = await createUpgrader(opts).check();
  assert.equal(current, "0.0.0");
  assert.equal(target, "2.0.0");
  await assert.rejects(() => fs.stat(path.join(dir, "journal.jsonl")));
});

test("recover() settles durable work without consulting the release source", async () => {
  const dir = await stateDir();
  const host = recordingHost();
  let sourceConsulted = false;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "journal.jsonl"),
    `${JSON.stringify({
      seq: 0,
      timestampMs: 1,
      intent: "rolled-back",
      detail: { formatVersion: "1" },
    })}\n`,
  );
  await persistOperation(dir, {
    formatVersion: 1,
    id: "recover-op",
    startedAtMs: 1,
    updatedAtMs: 1,
    fromVersion: "1.0.0",
    targetVersion: "2.0.0",
    previousStableVersion: "1.0.0",
    phase: "recovering",
    outcome: null,
    reason: "coordinator exited during handover",
    provenance: { who: "server-1", carrier: "web" },
    metadata: { originServerId: "server-1" },
    acknowledgedAtMs: null,
  });
  const upgrader = createUpgrader({
    host,
    stateDir: dir,
    source: {
      checkForUpdate: async () => {
        sourceConsulted = true;
        throw new Error("recover must not check releases");
      },
      fetchRelease: async () => {
        sourceConsulted = true;
        throw new Error("recover must not fetch releases");
      },
    },
    policy: "auto",
    notificationSink: async () => {},
  });

  await upgrader.recover();

  assert.equal(sourceConsulted, false);
  assert.deepEqual(host.calls, ["stop:experiment", "start:stable", "resume"]);
  const operation = await upgrader.operation();
  assert.equal(operation.kind, "observed");
  if (operation.kind === "observed") {
    assert.equal(operation.operation.id, "recover-op");
    assert.equal(operation.operation.previousStableVersion, "1.0.0");
    assert.equal(operation.operation.phase, "rolled-back");
    assert.equal(operation.operation.outcome, "rolled-back");
  }
});

test("recover() shares the upgrade lock and refuses a concurrent coordinator", async () => {
  const dir = await stateDir();
  const opts = await baseOpts(dir, await serveBytes());
  const { acquireUpgradeLock } = await import("./txn/lock.ts");
  const held = await acquireUpgradeLock(dir, 1);
  await assert.rejects(() => createUpgrader(opts).recover(), /UPGRADE_IN_PROGRESS/u);
  await held.release();
});

test("upgradeTo persists one K-owned operation receipt with previous stable and exact host correlation", async () => {
  const dir = await stateDir();
  const download = await serveDownload();
  try {
    const upgrader = createUpgrader(await baseOpts(dir, download.url));
    const outcome = await upgrader.upgradeTo("2.0.0", {
      consented: true,
      provenance: { who: "server-1", carrier: "web" },
      operation: {
        id: "request-1",
        startedAtMs: 10,
        metadata: { originServerId: "server-1" },
      },
    });
    assert.equal(outcome.result, "promoted");

    const receipt = await upgrader.operation();
    assert.equal(receipt.kind, "observed");
    if (receipt.kind !== "observed") return;
    assert.equal(receipt.operation.id, "request-1");
    assert.equal(receipt.operation.fromVersion, "0.0.0");
    assert.equal(receipt.operation.previousStableVersion, "0.0.0");
    assert.equal(receipt.operation.targetVersion, "2.0.0");
    assert.equal(receipt.operation.phase, "promoted");
    assert.equal(receipt.operation.outcome, "promoted");
    assert.deepEqual(receipt.operation.metadata, { originServerId: "server-1" });
    assert.equal(receipt.operation.acknowledgedAtMs, null);

    assert.equal(await upgrader.acknowledgeOperation("request-1"), "acknowledged");
    const acknowledged = await upgrader.operation();
    assert.equal(acknowledged.kind, "observed");
    if (acknowledged.kind === "observed") {
      assert.notEqual(acknowledged.operation.acknowledgedAtMs, null);
    }
  } finally {
    await download.close();
  }
});
