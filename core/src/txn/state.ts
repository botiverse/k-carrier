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
export function assertNever(x: never): never {
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

/**
 * A discriminated union so that an "illegal" combination is not representable:
 *
 *  - terminal / at-rest phases (`idle`, `promoted`, `rolled-back`) NEVER carry
 *    an experiment — an experiment slot that outlives a terminal phase is a
 *    leaked transaction (k.terminal-leaves-no-experiment would fire at runtime;
 *    here it is a compile error instead).
 *  - in-flight phases (`staged`..`readback`) ALWAYS carry an experiment — that
 *    is exactly what "in flight" means.
 *  - only `rolled-back` may carry a `rollbackReason`.
 *
 * Construction must choose a member consistent with `phase`; a `switch` over
 * `TxnState` narrows each member and forces every phase to make a decision
 * (the same discipline as `phaseAtRest`, lifted to the whole record).
 */
export type TxnState =
  | { phase: "idle"; stableVersion: string; experimentVersion: null; rollbackReason: null }
  | {
      phase: "staged" | "handing-over" | "running-experiment" | "readback";
      stableVersion: string;
      experimentVersion: string;
      rollbackReason: null;
    }
  | { phase: "promoted"; stableVersion: string; experimentVersion: null; rollbackReason: null }
  | { phase: "rolled-back"; stableVersion: string; experimentVersion: null; rollbackReason: string | null };

/** The in-flight, experiment-carrying phases (a helper for exhaustive narrowing). */
export const IN_FLIGHT_PHASES = ["staged", "handing-over", "running-experiment", "readback"] as const;

/** Append-only, write-ahead journal entry. fsync'd before the action runs. */
export interface JournalEntry {
  seq: number;
  timestampMs: number;
  intent: TxnPhase;
  detail: Record<string, string>;
}

/**
 * Downgrade rule: if an older core reads journal/state it does not
 * understand, it must FAIL CLOSED — refuse to act and say why — never
 * silently reinterpret. Encoded as a version field checked before replay.
 */
export const STATE_FORMAT_VERSION = 1;

/**
 * The strongly-typed input to `buildTxnState`. The argument is itself a
 * discriminated union over the phase, so an illegal input combination does
 * not type-check: a terminal/at-rest phase simply cannot carry an experiment,
 * only `rolled-back` may carry a reason, and an in-flight phase must carry
 * one. This is the "impossible states" discipline applied to the constructor's
 * arguments, not just its result.
 */
export type TxnStateInput =
  | { phase: "idle" | "promoted"; stableVersion: string }
  | { phase: "rolled-back"; stableVersion: string; rollbackReason?: string | null }
  | {
      phase: "staged" | "handing-over" | "running-experiment" | "readback";
      stableVersion: string;
      experimentVersion: string;
    };

/**
 * Soundly construct a `TxnState` member from a discriminated input.
 *
 * The input type already forbids the illegal combinations (an in-flight phase
 * cannot be given a missing experiment, a terminal phase cannot be given an
 * experiment, only `rolled-back` may carry a reason), so the result is sound
 * by construction — there is no per-phase coercion to get wrong here.
 *
 * The one place an inconsistent persisted world can slip in is the runtime
 * boundary that reads the journal and slots but only knows the phase at
 * runtime (see `createUpgrader.readState`); that boundary must decide the
 * phase before calling this, failing closed if a phase is in flight but the
 * experiment slot is empty.
 */
export function buildTxnState(input: TxnStateInput): TxnState {
  switch (input.phase) {
    case "idle":
    case "promoted":
      return { phase: input.phase, stableVersion: input.stableVersion, experimentVersion: null, rollbackReason: null };
    case "rolled-back":
      return { phase: input.phase, stableVersion: input.stableVersion, experimentVersion: null, rollbackReason: input.rollbackReason ?? null };
    case "staged":
    case "handing-over":
    case "running-experiment":
    case "readback":
      return { phase: input.phase, stableVersion: input.stableVersion, experimentVersion: input.experimentVersion, rollbackReason: null };
    default:
      return assertNever(input);
  }
}
