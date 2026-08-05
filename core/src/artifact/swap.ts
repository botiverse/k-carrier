/**
 * L0 atomic byte swap (test-plan M1: 换字节原子；半写不可见). The new
 * bytes are written to a temp file, fsynced, then renamed over the target —
 * a reader (or a kill mid-swap) only ever sees the OLD complete bytes or
 * the NEW complete bytes, never a partial write. A failed swap leaves the
 * target untouched and cleans up the temp file.
 *
 * (Windows in-place self-replace is a later platform concern; the
 * tmp→rename primitive is the portable core.)
 */
import { promises as fs } from "node:fs";
import { ArtifactError } from "./errors.ts";

export async function atomicWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    const fh = await fs.open(tmpPath, "w");
    try {
      await fh.writeFile(data);
      await fh.sync(); // durable before the rename becomes visible
    } finally {
      await fh.close();
    }
    await fs.rename(tmpPath, filePath); // atomic on POSIX: half-write invisible
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {
      // nothing to clean
    });
    throw new ArtifactError("SWAP_FAILED", `atomic write to ${filePath} failed`, { cause: err });
  }
}
