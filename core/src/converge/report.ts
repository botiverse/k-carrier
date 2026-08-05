/**
 * Building the ConvergenceReport, which is only worth anything if it never
 * invents a verdict.
 *
 * Two rules the shape enforces:
 *  - a predicate reports what was OBSERVED, never a default. `binaryAtTarget`
 *    passes because a live process said so, not because we got this far.
 *  - a property nobody looked at is `null` (undeclared), not `passed: true`.
 *    Reporting an unexamined property as passing once unlocked
 *    `retireLegacyManager()` -- retiring the machine's supervisor on the
 *    strength of silence.
 */
import type { ConvergenceReport, PredicateResult } from "./predicates.ts";
import type { ProcessEvidence } from "../lifecycle/hostAdapter.ts";

export function buildConvergenceReport(input: {
  version: string;
  evidence: ProcessEvidence | null;
  lifecycle: PredicateResult | null;
  declaredSurfaces: number;
  nowMs: number;
}): ConvergenceReport {
  const { version, evidence, lifecycle, declaredSurfaces, nowMs } = input;
  const binaryAtTarget: PredicateResult = {
    passed: evidence !== null && evidence.version === version,
    source: "host.healthProbe",
    observedAtMs: nowMs,
    detail: evidence
      ? { version: evidence.version, startId: evidence.startId, pid: String(evidence.pid) }
      : {},
  };
  const hostLifecycleConverged: PredicateResult | null =
    lifecycle ??
    (declaredSurfaces > 0
      ? { passed: false, source: "not-converged", observedAtMs: nowMs, detail: {} }
      : null); // the app declared no surface: never observed, never claimed
  return { binaryAtTarget, hostLifecycleConverged };
}
