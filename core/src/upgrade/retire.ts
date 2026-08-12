/**
 * retireReason — the fail-closed retirement gate (M5, extracted from
 * createUpgrader for the line budget). The legacy lifecycle manager may be
 * retired ONLY after host_lifecycle_converged passed on the last promote;
 * before that, retirement is refused with a typed HOLD — removing the old
 * supervisor without a converged replacement leaves the machine with
 * nothing to start the service.
 *
 * The HOLD reason must name the ACTUAL state: "never observed" (genesis)
 * and "cannot read the report" (unreadable) are two different sentences —
 * retirement is one-time and irreversible, so a fake reason is expensive
 * here.
 */
import type { ReportRead } from "../status/reportStore.ts";

export function retireReason(read: ReportRead): "retired" | { held: string } {
  if (read.kind === "genesis") {
    return {
      held:
        "cannot retire the legacy lifecycle manager before host_lifecycle_converged passed (no upgrade has converged yet)",
    };
  }
  if (read.kind === "unreadable") {
    return {
      held:
        `cannot retire the legacy lifecycle manager before host_lifecycle_converged passed — ` +
        `the last convergence report cannot be read (${read.reason})`,
    };
  }
  const lifecycle = read.report.hostLifecycleConverged ?? null;
  if (lifecycle === null) {
    return {
      held:
        "cannot retire the legacy lifecycle manager before host_lifecycle_converged passed" +
        " (this app declared no OS-lifecycle read-back surface, so it was never observed)",
    };
  }
  if (!lifecycle.passed) {
    return {
      held: "cannot retire the legacy lifecycle manager before host_lifecycle_converged passed",
    };
  }
  return "retired";
}
