/**
 * What recovery WOULD do, as a value — separate from doing it.
 *
 * `recover()` decides and acts in one pass, which makes the decision
 * impossible to inspect without changing the world. An adopter migrating onto
 * K needs exactly that: to ask "what would K conclude here?" while its own
 * mechanism still executes, and compare. If they answered it by
 * reimplementing this switch on their side, the two copies would drift, and
 * the drift would show up as fake divergences.
 *
 * So the decision lives here, `recover()` consumes it, and anyone comparing
 * gets the same answer K itself acts on rather than a lookalike.
 */
import type { JournalEntry } from "./state.ts";
import type { TxnPhase } from "./state.ts";

export type RecoveryAction =
  /** No journal at all: fresh install, stable running. */
  | { kind: "nothing"; reason: "fresh-install" }
  /** Last intent is terminal and its action is already reflected. */
  | { kind: "nothing"; reason: "already-settled" }
  /** WAL redo: intent durable, action may not have run. Idempotent to repeat. */
  | { kind: "redo-promote" }
  | { kind: "redo-clear" }
  /** Staged but handover never started: cheap undo, host untouched. */
  | { kind: "undo-staged" }
  /**
   * Died with the experiment possibly live. EVIDENCE decides between these
   * two, never a "this restart was planned" flag — a flag is a claim the crash
   * path can make just as easily.
   */
  | { kind: "needs-evidence"; intent: TxnPhase; experimentVersion: string }
  /**
   * Died in flight with an EMPTY experiment slot. There is no evidence to
   * weigh, so this is not a refusal — it is the same fail-closed rollback,
   * just with nothing to check first. Refusing here would strand a machine
   * that recover() has always been able to settle.
   */
  | { kind: "rollback-in-flight"; intent: TxnPhase }
  /** Journal written by a newer core. Fail closed rather than guess. */
  | { kind: "refuse"; reason: string };

/**
 * Pure: no I/O, no clock. `experimentVersion` is the slot reading the caller
 * already has; `null` means the experiment slot is empty.
 */
export function decideRecovery(
  last: JournalEntry | undefined,
  experimentVersion: string | null,
): RecoveryAction {
  if (!last) return { kind: "nothing", reason: "fresh-install" };
  switch (last.intent) {
    case "idle":
      return { kind: "nothing", reason: "already-settled" };
    case "promoted":
      return experimentVersion === null
        ? { kind: "nothing", reason: "already-settled" }
        : { kind: "redo-promote" };
    case "rolled-back":
      return experimentVersion === null
        ? { kind: "nothing", reason: "already-settled" }
        : { kind: "redo-clear" };
    case "staged":
      return { kind: "undo-staged" };
    case "handing-over":
    case "running-experiment":
    case "readback":
      return experimentVersion === null
        ? { kind: "rollback-in-flight", intent: last.intent }
        : { kind: "needs-evidence", intent: last.intent, experimentVersion };
    default:
      return {
        kind: "refuse",
        reason:
          `journal intent ${JSON.stringify(last.intent)} is not understood by this core ` +
          `(state format newer than binary); refusing to act`,
      };
  }
}
