/**
 * Upgrade lock — one transaction at a time per service identity.
 *
 * Every entrypoint constructs the same Upgrader (daemon loop, `self upgrade`,
 * install script, remote drive), so two of them CAN fire at once. Without a
 * lock the semantics of "what happened" are undefined: two transactions would
 * interleave over one journal and one pair of slots.
 *
 * Deliberately simple, matching the declared scope: the lock covers ONE
 * service identity (one stateDir). It is not a cross-instance orchestrator —
 * running several instances means several stateDirs, each with its own lock.
 *
 * Crash safety: the lock file records the holder's pid and start time, so a
 * lock left behind by a killed process is detected as stale rather than
 * wedging the install forever. "Stale" means the OS no longer knows that pid;
 * we never time out a lock whose holder is demonstrably alive.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { platformOpsFor } from "../platform/index.ts";

/** Bounded retries: an unclaimable lock is a typed failure, never a hang. */
const MAX_ATTEMPTS = 50;

export class UpgradeLockError extends Error {
  readonly code = "UPGRADE_IN_PROGRESS";

  constructor(holderPid: number) {
    super(
      `[UPGRADE_IN_PROGRESS] another upgrade is running (pid ${holderPid}); ` +
        `refusing to start a second transaction over the same state`,
    );
    this.name = "UpgradeLockError";
  }
}

interface LockRecord {
  pid: number;
  acquiredAtMs: number;
}

export interface UpgradeLock {
  release(): Promise<void>;
}

/**
 * Acquire the single-transaction lock, or throw UpgradeLockError.
 * `nowMs` is injected rather than read from Date so simulation stays
 * deterministic (clock seam discipline).
 */
export async function acquireUpgradeLock(stateDir: string, nowMs: number): Promise<UpgradeLock> {
  const lockPath = path.join(stateDir, "upgrade.lock");
  await fs.mkdir(stateDir, { recursive: true });
  const ops = platformOpsFor();

  const record: LockRecord = { pid: process.pid, acquiredAtMs: nowMs };
  let attempts = 0;
  for (;;) {
    try {
      // wx: fails if the file exists — the atomic "claim it" primitive.
      const fh = await fs.open(lockPath, "wx");
      try {
        await fh.writeFile(JSON.stringify(record));
      } finally {
        await fh.close();
      }
      return {
        async release() {
          await fs.rm(lockPath, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        // Never spin forever: a lock we can neither claim nor clear is a
        // typed failure, not a hang. (Hangs hide bugs; failures report them.)
        throw new Error(
          `[UPGRADE_LOCK_UNRESOLVABLE] could not acquire or clear ${lockPath} after ${MAX_ATTEMPTS} attempts`,
        );
      }
      const holder = await readHolder(lockPath);
      if (holder === "vanished") continue; // gone between open and read: retry
      // A non-positive pid is never a real holder — and must NEVER reach
      // process.kill, where pid<=0 addresses process GROUPS or every process.
      if (holder !== "unreadable" && holder.pid > 0 && ops.isProcessAlive(holder.pid)) {
        throw new UpgradeLockError(holder.pid);
      }
      // Holder is gone: its transaction died mid-flight. Recovery (journal
      // replay) will decide what to do with the state; clear the lock and
      // take it. Removing a specific stale file is safe to race — whoever
      // wins the next `wx` owns the lock.
      await fs.rm(lockPath, { force: true });
    }
  }
}

/**
 * "vanished"    = the file disappeared; retrying the claim is correct.
 * "unreadable"  = present but not a lock record; no holder can be proven
 *                 alive, so it must not block forever.
 */
async function readHolder(lockPath: string): Promise<LockRecord | "vanished" | "unreadable"> {
  let text: string;
  try {
    text = await fs.readFile(lockPath, "utf8");
  } catch {
    return "vanished";
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockRecord).pid === "number"
    ) {
      return parsed as LockRecord;
    }
    return "unreadable";
  } catch {
    return "unreadable";
  }
}
