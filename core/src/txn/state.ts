/**
 * Upgrade transaction: two-slot repository + append-only journal +
 * crash-recoverable state machine (Datadog fleet-installer model, hardened
 * with K's convergence predicates before promote).
 *
 * Invariants (each is a harness tooth, not prose):
 *  - Never two service incarnations running at once (no dual-run).
 *  - Never an unbootable host (no brick): any crash mid-transition recovers
 *    to `idle` (stable running) or completes the transition — decided by
 *    replaying the journal, never by heuristics.
 *  - Promote happens ONLY after predicates pass (see converge/). Rollback
 *    is always available until promote.
 *  - Intent is journaled BEFORE the action it describes (write-ahead).
 */
export type TxnPhase =
  | "idle" // stable running; no experiment staged
  | "staged" // experiment slot populated + sha256-verified; stable still running
  | "handing-over" // stable quiesced/stopped; experiment starting
  | "running-experiment" // experiment process up; predicates not yet evaluated
  | "readback" // predicates evaluating (same-source, live-process evidence)
  | "promoted" // experiment -> stable; old stable pending GC
  | "rolled-back"; // stable restored + resumed; experiment slot cleared; reason journaled

/**
 * Is the machine AT REST in this phase — safe to REFUSE new modification
 * (the rollback ownership gate draws on the action's nature). Exhaustive
 * over TxnPhase: a phase added later MUST make a decision here at compile
 * time (the `never` check in the default). An unknown phase from a NEWER
 * core defaults to at-rest: for modification, "don't touch" is the safe
 * default, never the exclusion-list trap where every future terminal
 * phase silently becomes "in-flight" = allowed to modify.
 */
function assertNever(x: never): never {
  throw new Error(`unknown TxnPhase ${String(x)}; refusing to classify — a phase a newer core wrote must not be touched`);
}

export function phaseAtRest(phase: TxnPhase): boolean {
  switch (phase) {
    case "idle":
    case "promoted":
    case "rolled-back":
      return true; // stable restored; nothing in flight — touching is NEW modification
    case "staged":
    case "handing-over":
    case "running-experiment":
    case "readback":
      return false; // K's own transaction in flight — settling is always allowed
    default:
      // A new TxnPhase is a compile error here (phase narrows to it and is
      // not `never`). A phase from a NEWER core at runtime is refused —
      // "don't touch" is the safe default, not the exclusion-list trap.
      return assertNever(phase);
  }
}

export interface TxnState {
  phase: TxnPhase;
  stableVersion: string;
  experimentVersion: string | null;
  /** Why the last rollback happened; null unless phase === "rolled-back". */
  rollbackReason: string | null;
}

/** Append-only, write-ahead journal entry. fsync'd before the action runs. */
export interface JournalEntry {
  seq: number;
  timestampMs: number;
  intent: TxnPhase;
  detail: Record<string, string>;
}

/**
 * Downgrade rule (#376): if an older core reads journal/state it does not
 * understand, it must FAIL CLOSED — refuse to act and say why — never
 * silently reinterpret. Encoded as a version field checked before replay.
 */
export const STATE_FORMAT_VERSION = 1;
