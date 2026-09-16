/**
 * The transition table — the single source of truth for the state machine's
 * shape, exported so the crash enumerator can GENERATE coverage from it
 * (harness-design §1.4: hand-listing kill points is illegal).
 *
 * Each transition names the action performed after its intent is journaled.
 * The enumerator derives kill points from this table, so adding a phase or
 * an edge without extending coverage makes the completeness tooth RED —
 * you cannot add state and forget to crash-test it.
 */
import type { TxnPhase } from "./state.ts";

export interface Transition {
  from: TxnPhase;
  to: TxnPhase;
  /** The durable/observable action taken after journaling `to`. */
  action:
    | "stage-experiment"
    | "handover-to-experiment"
    | "probe-experiment"
    | "evaluate-predicates"
    | "promote-experiment"
    | "restore-stable";
}

export const TRANSITIONS: readonly Transition[] = [
  { from: "idle", to: "staged", action: "stage-experiment" },
  { from: "staged", to: "handing-over", action: "handover-to-experiment" },
  { from: "handing-over", to: "running-experiment", action: "probe-experiment" },
  { from: "running-experiment", to: "readback", action: "evaluate-predicates" },
  { from: "readback", to: "promoted", action: "promote-experiment" },
  // Rollback edges: reachable from every non-terminal phase.
  { from: "staged", to: "rolled-back", action: "restore-stable" },
  { from: "handing-over", to: "rolled-back", action: "restore-stable" },
  { from: "running-experiment", to: "rolled-back", action: "restore-stable" },
  { from: "readback", to: "rolled-back", action: "restore-stable" },
];

export const TERMINAL_PHASES: readonly TxnPhase[] = ["idle", "promoted", "rolled-back"];

/** Every phase mentioned by the table (used by the completeness tooth). */
export function phasesInTable(): TxnPhase[] {
  const seen = new Set<TxnPhase>();
  for (const t of TRANSITIONS) {
    seen.add(t.from);
    seen.add(t.to);
  }
  return [...seen];
}
