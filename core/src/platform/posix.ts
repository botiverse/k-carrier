/**
 * POSIX implementation of the platform seam (linux, darwin).
 * The only place in core allowed to name rename/signals.
 */
import { promises as fs } from "node:fs";
import type { PlatformOps } from "./ops.ts";

async function atomicReplace(filePath: string, data: Uint8Array): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    const fh = await fs.open(tmpPath, "w");
    try {
      await fh.writeFile(data);
      await fh.sync(); // durable before the rename makes it visible
    } finally {
      await fh.close();
    }
    // Atomic on POSIX: a reader sees either the old file or the whole new one.
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export const posixOps: PlatformOps = {
  swapExecutable: atomicReplace,
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  killProcess(pid) {
    process.kill(pid, "SIGKILL");
  },
  async makeExecutable(filePath) {
    await fs.chmod(filePath, 0o755);
  },
  platformKey() {
    return `${process.platform}-${process.arch}`;
  },
};
