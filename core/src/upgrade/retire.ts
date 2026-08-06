/**
 * retireReason — the fail-closed retirement gate (M5, extracted from
 * createUpgrader for the line budget). The legacy lifecycle manager may be
 * retired ONLY after host_lifecycle_converged passed on the last promote;
 * before that, retirement is refused with a typed HOLD — removing the old
 * supervisor without a converged replacement leaves the machine with
 * nothing to start the service.
 */
import type { ConvergenceReport } from "../converge/predicates.ts";

export function retireReason(report: ConvergenceReport | null): "retired" | { held: string } {
  const lifecycle = report?.hostLifecycleConverged ?? null;
  if (lifecycle === null) {
    return {
      held:
        "cannot retire the legacy lifecycle manager before host_lifecycle_converged passed" +
        (report === null
          ? " (no upgrade has converged yet)"
          : " (this app declared no OS-lifecycle read-back surface, so it was never observed)"),
    };
  }
  if (!lifecycle.passed) {
    return {
      held: "cannot retire the legacy lifecycle manager before host_lifecycle_converged passed",
    };
  }
  return "retired";
}
