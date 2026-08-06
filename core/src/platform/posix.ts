/**
 * POSIX implementation of the platform seam (linux, darwin).
 * The only place in core allowed to name rename/signals.
 */
import { execFileSync } from "node:child_process";
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

/**
 * Does this Mac have arm64 hardware, whatever this process is running as?
 *
 * Untestable on a non-Mac, so it is one line delegating to the OS while the
 * DECISION it feeds lives in `platformKeyFor`, which is pure and pinned.
 */
function hardwareSupportsDarwinArm64(): boolean {
  try {
    return (
      execFileSync("/usr/sbin/sysctl", ["-in", "hw.optional.arm64"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "1"
    );
  } catch {
    return false; // not a Mac, sysctl missing, or no such key
  }
}

/**
 * Which manifest target this machine should be served.
 *
 * The one non-obvious case is Rosetta: an x64 Node on Apple Silicon reports
 * `process.arch === "x64"`, so the naive `platform-arch` picks the x64 target
 * FOREVER. The machine never moves to the native build, and an adopter who
 * publishes arm64 sees it silently ignored on exactly the hardware it is for.
 * Nothing errors -- the wrong artifact is a perfectly valid artifact.
 *
 * So on darwin+x64 we ask the HARDWARE, not the process.
 */
export function platformKeyFor(
  platform: string,
  processArch: string,
  supportsDarwinArm64: () => boolean,
): string {
  const arch =
    platform === "darwin" && processArch === "x64" && supportsDarwinArm64() ? "arm64" : processArch;
  return `${platform}-${arch}`;
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
    return platformKeyFor(process.platform, process.arch, hardwareSupportsDarwinArm64);
  },
};
