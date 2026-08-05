// @invariant — the facade's gate ORDER is the contract: nothing touches disk
// before consent, ownership, and compatibility have each had their say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createUpgrader, type CreateUpgraderOptions } from "./createUpgrader.ts";
import type { ReleaseSource } from "./artifact/source.ts";
import type { HostAdapter, ProcessEvidence, Slot } from "./lifecycle/hostAdapter.ts";

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

async function baseOpts(dir: string, url: string): Promise<CreateUpgraderOptions> {
  const host = recordingHost();
  return {
    host,
    source: sourceServing("2.0.0", url),
    policy: "auto",
    notificationSink: async () => {},
    rootKeys: [],
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
