// @invariant — one transaction at a time per service identity; a dead
// holder must never wedge the install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireUpgradeLock, UpgradeLockError } from "./lock.ts";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "k-lock-"));
}

test("a second concurrent transaction is refused with a typed error", async () => {
  const dir = await tmpDir();
  const first = await acquireUpgradeLock(dir, 1000);
  await assert.rejects(() => acquireUpgradeLock(dir, 1001), UpgradeLockError);
  await first.release();
  // released: the next one may proceed
  const second = await acquireUpgradeLock(dir, 1002);
  await second.release();
});

test("a lock left by a DEAD holder is taken over, not honoured forever", async () => {
  const dir = await tmpDir();
  // pid 2^22 is above the usual pid_max and reliably absent.
  await fs.writeFile(path.join(dir, "upgrade.lock"), JSON.stringify({ pid: 4194303, acquiredAtMs: 1 }));
  const lock = await acquireUpgradeLock(dir, 2000);
  await lock.release();
});

test("a live holder is never treated as stale, however old the lock is", async () => {
  const dir = await tmpDir();
  // our own pid is demonstrably alive; age must not matter
  await fs.writeFile(
    path.join(dir, "upgrade.lock"),
    JSON.stringify({ pid: process.pid, acquiredAtMs: 0 }),
  );
  await assert.rejects(() => acquireUpgradeLock(dir, 999_999_999), UpgradeLockError);
});

test("unreadable lock content does not wedge the install", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "upgrade.lock"), "not json at all");
  const lock = await acquireUpgradeLock(dir, 3000);
  await lock.release();
});

test("release is safe to call when the file is already gone", async () => {
  const dir = await tmpDir();
  const lock = await acquireUpgradeLock(dir, 4000);
  await fs.rm(path.join(dir, "upgrade.lock"), { force: true });
  await lock.release(); // must not throw
});

test("release is idempotent and cannot remove its successor's lock", async () => {
  const dir = await tmpDir();
  try {
    const first = await acquireUpgradeLock(dir, 1);
    await first.release();
    const next = await acquireUpgradeLock(dir, 2);
    await first.release();
    await assert.rejects(acquireUpgradeLock(dir, 3), UpgradeLockError);
    await next.release();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("real competing processes never overlap while reclaiming a dead owner", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await tmpDir();
  const source = new URL("./lock.ts", import.meta.url).href;
  try {
    await fs.writeFile(path.join(dir, "upgrade.lock"), JSON.stringify({ pid: 4194303, acquiredAtMs: 1 }));
    const children = Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", `
        import {acquireUpgradeLock} from ${JSON.stringify(source)};
        import {promises as fs} from 'node:fs';
        import {setTimeout as sleep} from 'node:timers/promises';
        const dir=${JSON.stringify(dir)};
        let wins=0;
        for (let i=0;i<30;i++) {
          let lock;
          try { lock=await acquireUpgradeLock(dir, Date.now()); }
          catch (e) { if(e.code!=='UPGRADE_IN_PROGRESS') throw e; await sleep(2); continue; }
          const marker=await fs.open(dir+'/critical', 'wx');
          await sleep(3);
          await marker.close(); await fs.unlink(dir+'/critical');
          await lock.release(); wins++;
        }
        console.log(wins);
      `], { stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let err = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err)));
    }));
    const wins = (await Promise.all(children)).map(Number).reduce((sum, count) => sum + count, 0);
    assert.ok(wins > 0, "the lock must allow progress as well as exclude overlap");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("releasing relocated state does not delete a new installation's lock", async () => {
  const dir = await tmpDir();
  const state = path.join(dir, "state");
  try {
    const original = await acquireUpgradeLock(state, 1);
    await fs.rename(state, path.join(dir, "quarantine"));
    const replacement = await acquireUpgradeLock(state, 2);
    await original.release();
    await assert.rejects(acquireUpgradeLock(state, 3), UpgradeLockError);
    await replacement.release();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
