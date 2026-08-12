/**
 * Status report (M6, L5) — the fleet read-back surface: what a machine
 * reports about itself is a READ-BACK, never an invention.
 *
 * Every field comes from the live sources at the moment of the call:
 *  - phase / stable / experiment: the txn state (slots + journal intent)
 *  - predicates: the last REAL convergence report's results — a machine
 *    that has never observed a promote reports `null` (NOT_OBSERVED), NOT
 *    `passed: true`. "never observed" has its own value (the M5 rule extended
 *    to the fleet surface: silence cannot be spent as evidence).
 *  - policy: the configured policy, verbatim.
 *  - provenance: the journal's read (genesis / observed / unreadable), or
 *    null when the app never wired a journal.
 */
import type { TxnState } from "../txn/state.ts";
import type { PredicateResult } from "../converge/predicates.ts";
import type { ProvenanceRead } from "../provenance/journal.ts";
import type { ReportRead } from "./reportStore.ts";

/**
 * The predicates' state — three shapes, mechanically distinct:
 *  - genesis: no report was ever written. The machine NEVER OBSERVED a
 *    promote — NOT_OBSERVED, never a fabricated pass.
 *  - unreadable: a report exists but cannot be read (EACCES/corrupt). The
 *    machine DID observe; its record is hidden, not absent. "I cannot see
 *    the data" is not "there is no data".
 *  - observed: the last real report, verbatim — `version` is the JOIN KEY
 *    (consumers join on it, never on the current stable/experiment: a real
 *    conclusion about 2.0.0 read as 3.0.0's is worse than a fake).
 */
export type StatusPredicates =
  | { kind: "genesis" }
  | { kind: "unreadable"; reason: string }
  | {
      kind: "observed";
      version: string;
      binaryAtTarget: PredicateResult;
      hostLifecycleConverged: PredicateResult | null;
    };

export interface StatusReport {
  phase: TxnState["phase"];
  stable: string;
  experiment: string | null;
  predicates: StatusPredicates;
  policy: "auto" | "confirm" | "notify-only";
  /** The provenance journal read; null = the app never wired a journal. */
  provenance: ProvenanceRead | null;
}

export function buildStatusReport(input: {
  state: TxnState;
  lastReport: ReportRead;
  policy: "auto" | "confirm" | "notify-only";
  provenance: ProvenanceRead | null;
}): StatusReport {
  return {
    phase: input.state.phase,
    stable: input.state.stableVersion,
    experiment: input.state.experimentVersion,
    predicates: reportPredicates(input.lastReport),
    policy: input.policy,
    provenance: input.provenance,
  };
}

function reportPredicates(read: ReportRead): StatusPredicates {
  if (read.kind === "genesis") return { kind: "genesis" };
  if (read.kind === "unreadable") return { kind: "unreadable", reason: read.reason };
  return {
    kind: "observed",
    version: read.report.version,
    binaryAtTarget: read.report.binaryAtTarget,
    hostLifecycleConverged: read.report.hostLifecycleConverged,
  };
}
