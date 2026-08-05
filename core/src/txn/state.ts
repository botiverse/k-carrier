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
  | "staged" // experiment slot populated + signature-verified; stable still running
  | "handing-over" // stable quiesced/stopped; experiment starting
  | "running-experiment" // experiment process up; predicates not yet evaluated
  | "readback" // predicates evaluating (same-source, live-process evidence)
  | "promoted" // experiment -> stable; old stable pending GC
  | "rolled-back"; // stable restored + resumed; experiment slot cleared; reason journaled

export interface TxnState {
  phase: TxnPhase;
  stableVersion: string;
  experimentVersion: string | null;
  /** Why the last rollback happened; null unless phase === "rolled-back". */
  rollbackReason: string | null;
  /**
   * Did the artifact in the experiment slot pass the signature chain?
   * undefined when no experiment is staged. This feeds
   * k.no-unverified-artifact, which was inert while nothing reported it.
   */
  experimentSignatureVerified?: boolean;
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
