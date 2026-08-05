/**
 * PlatformOps — the seam where OS-shaped behaviour lives.
 *
 * Multi-platform from day 1, because these are not implementation details of
 * one operation: the STEPS differ per OS.
 *
 *   swapExecutable  POSIX: write tmp -> fsync -> rename over the target.
 *                   Windows: you cannot rename over a RUNNING .exe (file
 *                   lock), so the running image must be moved aside first
 *                   and the new bytes put in its place. Different sequence,
 *                   not a different syscall.
 *   isProcessAlive  POSIX: signal 0. Windows: no signals at all.
 *   killProcess     POSIX: SIGKILL. Windows: TerminateProcess semantics.
 *
 * A ratchet keeps signal names / process.kill / rename out of the rest of
 * core, so a POSIX assumption cannot quietly grow into the engine.
 */
export interface PlatformOps {
  /** Replace an executable's bytes; must be crash-safe (never a half file). */
  swapExecutable(filePath: string, data: Uint8Array): Promise<void>;
  /** Does the OS still know this pid? */
  isProcessAlive(pid: number): boolean;
  /** Terminate without giving the process a chance to clean up (crash sim / teardown). */
  killProcess(pid: number): void;
  /** Mark a file executable where the concept exists; a no-op where it does not. */
  makeExecutable(filePath: string): Promise<void>;
  /**
   * Move a path (file or directory) into place. Used to publish a slot
   * atomically. Separate from swapExecutable because that one is about a
   * RUNNING image; this one is plain state.
   */
  renamePath(from: string, to: string): Promise<void>;
  /** Identifier used to select a manifest target, e.g. "linux-x64". */
  platformKey(): string;
}

export class PlatformUnsupportedError extends Error {
  readonly code = "PLATFORM_UNSUPPORTED";

  constructor(operation: string, platform: string) {
    super(
      `[PLATFORM_UNSUPPORTED] ${operation} is not implemented for ${platform} yet — ` +
        `K refuses to approximate it rather than corrupt an install`,
    );
    this.name = "PlatformUnsupportedError";
  }
}
