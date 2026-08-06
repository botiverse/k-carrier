/**
 * finishUpgradeOutcome — the engine outcome becomes the facade outcome:
 * report the stage, notify the sink, build the convergence report
 * (promoted only), and return. Split out of createUpgrader so that file
 * stays under the line budget; the semantics are unchanged from the inline
 * version.
 */
import type { NotificationEvent, UpgradeOutcome } from "../upgrader.ts";
import type { UpgradeProgress } from "../progress.ts";
import type { EngineOutcome } from "../txn/engine.ts";
import type { ConvergenceReport, PredicateResult } from "../converge/predicates.ts";
import type { ProcessEvidence } from "../lifecycle/hostAdapter.ts";
import { buildConvergenceReport } from "../converge/report.ts";

export interface FinishUpgradeDeps {
  notify: (kind: NotificationEvent["kind"], detail: Record<string, string>) => Promise<void>;
  reportStage: (progress: UpgradeProgress) => void;
  /** The version the reconcile attempted (the engine's rolled-back outcome
   * carries no version — the attempt's target does). */
  targetVersion: string;
  /** Number of OS-lifecycle surfaces the app declared (0 = never observed). */
  declaredSurfaces: number;
  nowMs: number;
  evidence: ProcessEvidence | null;
  lifecycle: PredicateResult | null;
}

export interface FinishedUpgrade {
  outcome: UpgradeOutcome;
  /** Non-null only for a promote (the retirement gate reads it). */
  report: ConvergenceReport | null;
}

export async function finishUpgradeOutcome(outcome: EngineOutcome, deps: FinishUpgradeDeps): Promise<FinishedUpgrade> {
  if (outcome.result === "promoted") {
    deps.reportStage({ stage: "promoted", version: outcome.version });
    const report = buildConvergenceReport({
      version: outcome.version,
      evidence: deps.evidence,
      lifecycle: deps.lifecycle,
      declaredSurfaces: deps.declaredSurfaces,
      nowMs: deps.nowMs,
    });
    await deps.notify("promoted", { version: outcome.version });
    return { outcome: { result: "promoted", report }, report };
  }
  if (outcome.result === "rolled-back") {
    deps.reportStage({ stage: "rolled-back", version: deps.targetVersion });
    await deps.notify("rolled-back", { reason: outcome.reason });
    return { outcome: { result: "rolled-back", reason: outcome.reason, report: null }, report: null };
  }
  return { outcome: { result: "up-to-date" }, report: null };
}
