/**
 * Invariants — K's shared, executable vocabulary of "what must always be
 * true", exported as a library rather than buried in K's own tests.
 *
 * One definition, three consumers:
 *   1. K's harness teeth (assert after scripted steps)
 *   2. the deterministic simulator (assert after EVERY effect, every seed)
 *   3. adopters — in their own tests and simulations, alongside their own
 *      app invariants registered in the same shape
 *
 * Why this shape: an invariant is a pure predicate over an observable
 * snapshot. It never reaches into internals, so the same check works
 * in-process, in simulation, and black-box against `status --json`.
 * Returning a *reason string* (not a boolean) means a violation explains
 * itself wherever it fires — including from a seed replay hours later.
 */
import type { TxnPhase } from "./txn/state.ts";

/** What an invariant is allowed to see. Mirrors `status --json`. */
export interface WorldSnapshot {
  phase: TxnPhase;
  slots: { stable: string | null; experiment: string | null };
  /** Live service incarnations observed right now. */
  liveProcesses: Array<{ slot: "stable" | "experiment"; pid: number; startId: string; version: string }>;
  /** Journal intents in append order. */
  journalIntents: TxnPhase[];
  /**
   * Opaque, comparable digest of host workload state (sessions/jobs).
   * Hosts that preserve workloads across upgrade emit a stable digest.
   */
  workloadDigest?: string;
  /**
   * startId of the incarnation that was live BEFORE the current transition.
   * Present in real status readbacks; lets oracles prove a restart actually
   * happened rather than trusting a version string (Raft #5245 family).
   */
  priorIncarnationStartId?: string;
}

/** null = holds; string = why it was violated (shown to humans and in seed replays). */
export type InvariantResult = string | null;

export interface Invariant<S = WorldSnapshot> {
  id: string;
  description: string;
  check: (snapshot: S) => InvariantResult;
}

/** Never two service incarnations alive at once. */
export const neverDualRun: Invariant = {
  id: "k.never-dual-run",
  description: "at most one service incarnation is live at any moment",
  check: (s) =>
    s.liveProcesses.length > 1
      ? `${s.liveProcesses.length} live incarnations: ${s.liveProcesses
          .map((p) => `${p.slot}#${p.pid}@${p.version}`)
          .join(", ")}`
      : null,
};

/** Never a host with nothing runnable: some slot always holds a version. */
export const neverBricked: Invariant = {
  id: "k.never-bricked",
  description: "at least one slot always holds a runnable version",
  check: (s) =>
    s.slots.stable === null && s.slots.experiment === null
      ? "both slots empty — nothing left to run"
      : null,
};

/** A live process must come from a slot that actually holds that version. */
export const liveProcessMatchesSlot: Invariant = {
  id: "k.live-process-matches-slot",
  description: "a live incarnation's version matches the slot it was started from",
  check: (s) => {
    for (const p of s.liveProcesses) {
      const slotVersion = s.slots[p.slot];
      if (slotVersion !== null && slotVersion !== p.version) {
        return `${p.slot} slot holds ${slotVersion} but a live process reports ${p.version}`;
      }
    }
    return null;
  },
};

/** Intent is journaled before the phase is entered (WAL ordering). */
export const journalPrecedesPhase: Invariant = {
  id: "k.journal-precedes-phase",
  description: "the current phase was journaled before being entered",
  check: (s) =>
    s.phase !== "idle" && !s.journalIntents.includes(s.phase)
      ? `phase ${s.phase} entered with no journal entry for it`
      : null,
};

/** Terminal phases leave no experiment slot behind. */
export const terminalLeavesNoExperiment: Invariant = {
  id: "k.terminal-leaves-no-experiment",
  description: "after promote/rollback the experiment slot is cleared",
  check: (s) =>
    (s.phase === "promoted" || s.phase === "rolled-back") && s.slots.experiment !== null
      ? `phase ${s.phase} but experiment slot still holds ${s.slots.experiment}`
      : null,
};

/** The built-in set. Adopters concat their own app invariants. */
export const BUILT_IN_INVARIANTS: readonly Invariant[] = [
  neverDualRun,
  neverBricked,
  liveProcessMatchesSlot,
  journalPrecedesPhase,
  terminalLeavesNoExperiment,
];

export interface Violation {
  invariantId: string;
  reason: string;
}

/** Check a snapshot against a set; returns every violation (not just the first). */
export function checkInvariants(
  snapshot: WorldSnapshot,
  invariants: readonly Invariant[] = BUILT_IN_INVARIANTS,
): Violation[] {
  const out: Violation[] = [];
  for (const inv of invariants) {
    const reason = inv.check(snapshot);
    if (reason !== null) out.push({ invariantId: inv.id, reason });
  }
  return out;
}

/**
 * Workload preservation across a transition. Kept separate because it
 * compares two snapshots rather than judging one — hosts that declare a
 * workloadDigest get this for free, in upgrade AND rollback paths.
 */
export function workloadPreserved(before: WorldSnapshot, after: WorldSnapshot): InvariantResult {
  if (before.workloadDigest === undefined || after.workloadDigest === undefined) return null;
  return before.workloadDigest === after.workloadDigest
    ? null
    : `workload digest changed across the transition: ${before.workloadDigest} -> ${after.workloadDigest}`;
}
