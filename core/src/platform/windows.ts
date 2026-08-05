/**
 * Windows implementation of the platform seam.
 *
 * Deliberately incomplete: the swap sequence differs (a running .exe cannot
 * be renamed over — the running image must be moved aside first), so this
 * throws a typed PLATFORM_UNSUPPORTED rather than approximating POSIX
 * behaviour and corrupting an install. The interface exists on day 1 so the
 * engine is written against the right shape; the implementation lands with
 * the Windows milestone.
 */
import type { PlatformOps } from "./ops.ts";
import { PlatformUnsupportedError } from "./ops.ts";

export const windowsOps: PlatformOps = {
  async swapExecutable() {
    throw new PlatformUnsupportedError("swapExecutable", "win32");
  },
  isProcessAlive() {
    throw new PlatformUnsupportedError("isProcessAlive", "win32");
  },
  killProcess() {
    throw new PlatformUnsupportedError("killProcess", "win32");
  },
  async makeExecutable() {
    // No executable bit on Windows; nothing to do (this one IS a real no-op).
    await Promise.resolve();
  },
  platformKey() {
    return `${process.platform}-${process.arch}`;
  },
};
