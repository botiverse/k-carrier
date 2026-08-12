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

test("the swap preserves the target's file mode (a self-replacing executable stays executable)", async () => {
  const dir = await tmpDir();
  const target = path.join(dir, "app.bin");
  try {
    await fs.writeFile(target, new TextEncoder().encode("old"), { mode: 0o755 });
    await atomicWriteFile(target, new TextEncoder().encode("new"));
    const mode = (await fs.stat(target)).mode;
    if (process.platform === "win32") {
      // Windows has no executable bit (mode stays 100666): the swap must
      // still leave the bytes replaced and the file intact — the exec-bit
      // semantics are POSIX-only.
      assert.equal(Buffer.from(await fs.readFile(target)).toString("utf8"), "new", "the swapped bytes must be in place");
    } else {
      assert.ok(mode & 0o100, `executable bit must survive the swap (mode ${mode.toString(8)})`);
      // a non-executable target stays non-executable
      await fs.writeFile(target, new TextEncoder().encode("old2"));
      await fs.chmod(target, 0o644);
      await atomicWriteFile(target, new TextEncoder().encode("new2"));
      assert.ok(!((await fs.stat(target)).mode & 0o100), "non-executable target stays non-executable");
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
