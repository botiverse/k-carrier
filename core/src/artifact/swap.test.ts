// @invariant — L0 atomic swap: the target is only ever the complete old
// bytes or the complete new bytes (tmp → fsync → rename); a failed swap
// leaves the target untouched and cleans the temp file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import { atomicWriteFile } from "./swap.ts";

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "k-swap-"));
}

test("atomicWriteFile replaces the target with complete new bytes", async () => {
  const dir = await tmpDir();
  const target = path.join(dir, "app.bin");
  try {
    const oldBytes = new TextEncoder().encode("old");
    await atomicWriteFile(target, oldBytes);
    assert.deepEqual(new Uint8Array(await fs.readFile(target)), oldBytes);
    const newBytes = new TextEncoder().encode("new-version-bytes");
    await atomicWriteFile(target, newBytes);
    assert.deepEqual(new Uint8Array(await fs.readFile(target)), newBytes);
    assert.deepEqual(await fs.readdir(dir), ["app.bin"], "no .tmp may remain after success");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a failing swap (unwritable dir) leaves the target untouched", async () => {
  const dir = await tmpDir();
  const target = path.join(dir, "app.bin");
  await atomicWriteFile(target, new TextEncoder().encode("old"));
  const before = new Uint8Array(await fs.readFile(target));
  try {
    const broken = path.join(dir, "no-such-subdir", "app.bin"); // parent missing -> open fails
    await assert.rejects(atomicWriteFile(broken, new TextEncoder().encode("x")), /SWAP_FAILED/);
    assert.deepEqual(new Uint8Array(await fs.readFile(target)), before, "target untouched");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
