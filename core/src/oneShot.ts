import type { Upgrader, UpgradeOutcome } from "./upgrader.ts";

/** Result of a short-lived external K executor. */
export interface OneShotResult { outcome: UpgradeOutcome; exitCode: 0 | 1 | 2 }

/**
 * Drive one fixed version and exit. Bootstrap scripts/self-update commands
 * download and verify this executor; the resident app never upgrades itself.
 * Only a terminal promote/up-to-date is exit 0; held is 2; failure/rollback 1.
 */
export async function runOneShotUpgrade(
  upgrader: Upgrader,
  targetVersion: string,
  options: { consented?: boolean } = {},
): Promise<OneShotResult> {
  try {
    const outcome = await upgrader.upgradeTo(targetVersion, options);
    if (outcome.result === "promoted" || outcome.result === "up-to-date") return { outcome, exitCode: 0 };
    if (outcome.result === "held") return { outcome, exitCode: 2 };
    return { outcome, exitCode: 1 };
  } catch {
    const outcome: UpgradeOutcome = { result: "rolled-back", reason: "one-shot executor failed", report: null };
    return { outcome, exitCode: 1 };
  }
}
