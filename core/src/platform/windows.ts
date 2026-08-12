/**
 * Windows implementation of the platform seam.
 *
 * The swap sequence differs from POSIX because a RUNNING .exe is
 * NTFS-locked: it can be RENAMED (moved aside) but not deleted or
 * overwritten in place. So the swap is move-aside → place-new →
 * pending-delete — the shape prior-art.md documents from Tailscale's
 * Windows updater. The aside file stays until the old process exits; the
 * next successful swap removes it.
 *
 * Process ops use `process.kill` like POSIX, but on Windows the semantics
 * are libuv's: signal 0 is OpenProcess + GetExitCodeProcess (an existence
 * check — the honest "is it alive" question, since Windows has no signals)
 * and SIGKILL is TerminateProcess. There is no signal delivery, so there is
 * nothing a process could catch or ignore.
 */
import { promises as fs } from "node:fs";
import type { PlatformOps } from "./ops.ts";

async function swapExecutable(filePath: string, data: Uint8Array): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const asidePath = `${filePath}.old`;
  const fh = await fs.open(tmpPath, "w");
  try {
    await fh.writeFile(data);
    await fh.sync(); // durable before it becomes visible at the real path
  } finally {
    await fh.close();
  }
  try {
    // Move the running image aside. Renaming a locked .exe is allowed on
    // Windows; deleting or overwriting it is not.
    await fs.rename(filePath, asidePath);
  } catch (err) {
    // First install (or a previous swap already moved it): no old image.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Place the new image at the canonical path. The old name is now free, so
  // a plain move works — the target does not exist.
  await fs.rename(tmpPath, filePath);
  // Best-effort: the aside may be the still-running old image (locked until
  // the process exits). A leftover is removed by the next swap.
  await fs.rm(asidePath, { force: true }).catch(() => {});
}

export const windowsOps: PlatformOps = {
  swapExecutable,
  isProcessAlive(pid) {
    // libuv maps signal 0 to an OpenProcess + GetExitCodeProcess existence
    // check on Windows — the honest liveness question, not a signal.
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  killProcess(pid) {
    // libuv maps SIGKILL to TerminateProcess: no cleanup, no escape.
    process.kill(pid, "SIGKILL");
  },
  async renamePath(from, to) {
    // Plain state moves DO work on Windows (unlike replacing a running .exe).
    await fs.rename(from, to);
  },
  async makeExecutable() {
    // No executable bit on Windows; nothing to do (a real no-op).
    await Promise.resolve();
  },
  platformKey() {
    return `${process.platform}-${process.arch}`;
  },
};
