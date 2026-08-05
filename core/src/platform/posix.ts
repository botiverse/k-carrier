/**
 * POSIX implementation of the platform seam (linux, darwin).
 * The only place in core allowed to name rename/signals.
 */
import { promises as fs } from "node:fs";
import type { PlatformOps } from "./ops.ts";

async function atomicReplace(filePath: string, data: Uint8Array): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    // Preserve the target's mode across the swap: a self-replacing
    // executable must stay executable (a leftover tmp from a previous
    // crash must not dictate the new file's permissions either).
    let mode: number | undefined;
    try {
      mode = (await fs.stat(filePath)).mode;
    } catch {
      // target does not exist yet: default permissions
    }
    const fh = await fs.open(tmpPath, "w");
    try {
      if (mode !== undefined) await fh.chmod(mode & 0o777);
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
  async renamePath(from, to) {
    await fs.rename(from, to);
  },
  async makeExecutable(filePath) {
    await fs.chmod(filePath, 0o755);
  },
  platformKey() {
    return `${process.platform}-${process.arch}`;
  },
};
