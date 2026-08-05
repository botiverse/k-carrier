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
  /** Did the artifact currently in the experiment slot pass the signature chain? */
  experimentSignatureVerified?: boolean;
  /** Who owns this install: ourselves, or an external manager (PM/injector)? */
  installOwnership?: "self" | "managed-elsewhere";
}

/** null = holds; string = why it was violated (shown to humans and in seed replays). */
export type InvariantResult = string | null;

/**
 * What the HOST must do for a conditional guarantee to hold (assume-guarantee).
 * The left side of "if the app satisfies A, K guarantees G" — the app's
 * responsibility, verifiable by the harness against its adapter. Closed set:
 * if you need a new one, it is a design decision, not a free-text note.
 */
export type HostAssumption =
  | "quiesce-resume-inverse"        // parked workloads are unchanged while parked
  | "probe-from-live-process"       // evidence comes from the running process, not files
  | "compatibility-declared"        // checkCompatibility is implemented and correct
  | "data-format-backward-compatible"; // version N can read what N+1 wrote

export interface Invariant<S = WorldSnapshot> {
  id: string;
  description: string;
  /**
   * Empty/absent = K guarantees this UNCONDITIONALLY.
   * Non-empty = K guarantees it only if the host satisfies these assumptions.
   * This is how an adopter tells, from the library alone, which guarantees are
   * ours and which depend on their own code.
   */
  assumes?: readonly HostAssumption[];
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

/** Nothing reaches a slot without a verified signature chain. */
export const noUnverifiedArtifact: Invariant = {
  id: "k.no-unverified-artifact",
  description: "an artifact only occupies the experiment slot after its signature chain verified",
  check: (s) =>
    s.slots.experiment !== null && s.experimentSignatureVerified === false
      ? `experiment slot holds ${s.slots.experiment} but its signature chain was not verified`
      : null,
};

/** A copy owned by another manager never upgrades itself. */
export const managedCopyNeverSelfUpgrades: Invariant = {
  id: "k.managed-copy-never-self-upgrades",
  description: "an install owned by an external manager performs no upgrade of its own",
  check: (s) =>
    s.installOwnership === "managed-elsewhere" && s.phase !== "idle"
      ? `install is managed elsewhere but a transaction reached phase ${s.phase}`
      : null,
};

/** The built-in set. Adopters concat their own app invariants. */
export const BUILT_IN_INVARIANTS: readonly Invariant[] = [
  neverDualRun,
  neverBricked,
  liveProcessMatchesSlot,
  journalPrecedesPhase,
  terminalLeavesNoExperiment,
  noUnverifiedArtifact,
  managedCopyNeverSelfUpgrades,
];

/**
 * Deliberately NOT snapshot invariants — stated here so their absence is a
 * decision, not an oversight:
 *  - "no side effect before consent" and "every reconcile is journaled" are
 *    properties of an EVENT SEQUENCE, not of a single state. Forcing them into
 *    a snapshot predicate would require smuggling history into the snapshot;
 *    they are teeth over a scenario trace instead (policy/provenance teeth).
 */

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
/**
 * LIVENESS (progress), deliberately separate from the safety set above.
 *
 * Every safety invariant here is satisfiable by doing nothing at all, so
 * safety alone cannot say an updater works. This is the minimal progress
 * property: a transaction that started must reach a terminal phase within a
 * bounded number of steps — never parked in `staged`/`readback` forever.
 */
export function reachesTerminalWithin(
  phaseTrace: readonly TxnPhase[],
  maxSteps: number,
): InvariantResult {
  const terminal = new Set<TxnPhase>(["idle", "promoted", "rolled-back"]);
  const last = phaseTrace.at(-1);
  if (last !== undefined && terminal.has(last)) return null;
  return phaseTrace.length >= maxSteps
    ? `transaction still in ${last ?? "unknown"} after ${phaseTrace.length} steps (limit ${maxSteps}) — no progress to a terminal phase`
    : null;
}

export const WORKLOAD_PRESERVED_ASSUMES: readonly HostAssumption[] = ["quiesce-resume-inverse"];

export function workloadPreserved(before: WorldSnapshot, after: WorldSnapshot): InvariantResult {
  if (before.workloadDigest === undefined || after.workloadDigest === undefined) return null;
  return before.workloadDigest === after.workloadDigest
    ? null
    : `workload digest changed across the transition: ${before.workloadDigest} -> ${after.workloadDigest}`;
}
