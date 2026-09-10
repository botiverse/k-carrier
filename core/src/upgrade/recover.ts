import { HostCallUncertain } from "../txn/hostCallBudget.ts";
import { loadOperation, loadArchivedOperation, OperationReplay } from "../operation.ts";
import type { Clock } from "../clock.ts";
import type { UpgradeEngine } from "../txn/engine.ts";
import { acquireUpgradeLock } from "../txn/lock.ts";

/** Settle an existing transaction under the same lock as every other drive. */
export async function recoverUpgrade(
  stateDir: string,
  clock: Clock,
  engine: UpgradeEngine,
  afterRecover?: () => Promise<void>,
  expected?: { id: string; targetVersion: string },
): Promise<void> {
  const lock = await acquireUpgradeLock(stateDir, clock.nowMs());
  let release = true;
  try {
    const current = await loadOperation(stateDir);
    if (current.kind === "unreadable") throw new Error(current.reason);
    if (expected) {
      const archived = await loadArchivedOperation(stateDir, expected.id);
      if (archived.kind === "unreadable") throw new Error(archived.reason);
      const prior = archived.kind === "observed" ? archived : current;
      if (prior.kind !== "observed" || prior.operation.id !== expected.id) {
        throw new Error("RECOVERY_OPERATION_NOT_FOUND");
      }
      if (prior.operation.targetVersion !== expected.targetVersion) throw new Error("OPERATION_ID_CONFLICT");
      if (prior.operation.outcome !== null) throw new OperationReplay(prior.operation);
    }
    await engine.recover();
    await afterRecover?.();
  } catch (error) {
    // A timed-out promise may still execute. Keep ownership until this worker
    // exits; its successor must fence external controller effects as well.
    if (error instanceof HostCallUncertain) release = false;
    throw error;
  } finally {
    if (release) await lock.release();
  }
}
