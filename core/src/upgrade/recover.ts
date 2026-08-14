import type { Clock } from "../clock.ts";
import type { UpgradeEngine } from "../txn/engine.ts";
import { acquireUpgradeLock } from "../txn/lock.ts";

/** Settle an existing transaction under the same lock as every other drive. */
export async function recoverUpgrade(
  stateDir: string,
  clock: Clock,
  engine: UpgradeEngine,
  afterRecover?: () => Promise<void>,
): Promise<void> {
  const lock = await acquireUpgradeLock(stateDir, clock.nowMs());
  try {
    await engine.recover();
    await afterRecover?.();
  } finally {
    await lock.release();
  }
}
