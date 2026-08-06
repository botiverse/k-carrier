/**
 * Status report (M6, L5) — the fleet read-back surface: what a machine
 * reports about itself is a READ-BACK, never an invention.
 *
 * Every field comes from the live sources at the moment of the call:
 *  - phase / stable / experiment: the txn state (slots + journal intent)
 *  - predicates: the last REAL convergence report's results — a machine
 *    that has never observed a promote reports `null` (NOT_OBSERVED), NOT
 *    `passed: true`. "没看过" has its own value (archer's M5 rule extended
 *    to the fleet surface: silence cannot be spent as evidence).
 *  - policy: the configured policy, verbatim.
 *  - provenance: the journal's read (genesis / observed / unreadable), or
 *    null when the app never wired a journal.
 */
import type { TxnState } from "../txn/state.ts";
import type { ConvergenceReport, PredicateResult } from "../converge/predicates.ts";
import type { ProvenanceRead } from "../provenance/journal.ts";

export interface StatusReport {
  phase: TxnState["phase"];
  stable: string;
  experiment: string | null;
  predicates: {
    /** The last REAL binaryAtTarget evaluation; null = never observed. */
    binaryAtTarget: PredicateResult | null;
    /** The last REAL host_lifecycle_converged evaluation; null = never observed. */
    hostLifecycleConverged: PredicateResult | null;
  };
  policy: "auto" | "confirm" | "notify-only";
  /** The provenance journal read; null = the app never wired a journal. */
  provenance: ProvenanceRead | null;
}

export function buildStatusReport(input: {
  state: TxnState;
  lastReport: ConvergenceReport | null;
  policy: "auto" | "confirm" | "notify-only";
  provenance: ProvenanceRead | null;
}): StatusReport {
  return {
    phase: input.state.phase,
    stable: input.state.stableVersion,
    experiment: input.state.experimentVersion,
    predicates: {
      // A report that never happened is NOT_OBSERVED — never a fabricated
      // pass and never a fabricated failure: both would spend silence as
      // evidence.
      binaryAtTarget: input.lastReport?.binaryAtTarget ?? null,
      hostLifecycleConverged: input.lastReport?.hostLifecycleConverged ?? null,
    },
    policy: input.policy,
    provenance: input.provenance,
  };
}
