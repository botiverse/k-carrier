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
