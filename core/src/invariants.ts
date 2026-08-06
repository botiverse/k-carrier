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
 *
 * ---------------------------------------------------------------------------
 * SCOPE — what "the service" means here, stated so nothing is assumed:
 *
 *   K reasons about exactly ONE service identity per Upgrader: the process(es)
 *   its HostAdapter starts and stops. It is NOT a process supervisor for the
 *   machine and knows nothing about other processes that happen to run the
 *   same binary.
 *
 *   - swap profile: concurrent old-version processes are NORMAL (think many
 *     open CLI sessions). They are not K-managed, so no invariant here says
 *     anything about them. `never-dual-run` is vacuous in this profile rather
 *     than accidentally satisfied.
 *   - service / hosted: exactly one live incarnation of that identity, which
 *     is what `never-dual-run` constrains.
 *
 *   PROCESS MODEL (v0, declared rather than inferable from call order):
 *     EXCLUSIVE HANDOFF. At most one incarnation of the K-managed identity is
 *     alive at a time; a handoff is quiesce -> stop(old) -> start(new) -> prove.
 *     There is a downtime window by construction, and K makes it short rather
 *     than pretending it does not exist.
 *
 *     Zero-downtime overlap (start new, drain old, then stop old) is a
 *     DIFFERENT process model, not a flag on this one: it has a legitimate
 *     "both alive" state, needs a drain contract instead of quiesce, and
 *     changes which invariants hold. It is NOT implemented (ruled niche for
 *     v0). Anything claiming K supports it would be claiming a guarantee K
 *     does not make.
 *
 *   OUT OF SCOPE for v0 (deliberately, not by oversight): one binary running
 *   several instances with different arguments. One Upgrader owns one service
 *   identity; run one Upgrader per instance (separate stateDir), or have the
 *   adapter treat the whole set as a single identity. K does not orchestrate
 *   across instances, and no invariant here should be read as if it did.
 * ---------------------------------------------------------------------------
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
  | "data-format-backward-compatible" // version N can read what N+1 wrote
  | "exclusive-handoff"             // one live incarnation at a time: stop old, then start new
  | "resident-service";             // the host runs a process that is supposed to BE alive

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

/**
 * Never two live incarnations OF THE SERVICE IDENTITY K MANAGES.
 * Says nothing about other processes running the same binary (see SCOPE):
 * in the swap profile liveProcesses is empty, so this is vacuous by design.
 */
export const neverDualRun: Invariant = {
  id: "k.never-dual-run",
  description:
    "at most one live incarnation of the K-managed service identity (vacuous in the swap profile)",
  // NOT a universal truth about upgrades — it holds under K's declared process
  // model (exclusive handoff). An app that starts the new incarnation before
  // draining the old one is not violating a law of nature; it is running a
  // model K does not implement (see PROCESS MODEL below).
  assumes: ["exclusive-handoff"],
  check: (s) =>
    s.liveProcesses.length > 1
      ? `${s.liveProcesses.length} live incarnations: ${s.liveProcesses
          .map((p) => `${p.slot}#${p.pid}@${p.version}`)
          .join(", ")}`
      : null,
};

/**
 * Never a host with nothing runnable. Concerns the SLOTS (bytes on disk), not
 * whether a process is currently up: a stopped service with intact stable
 * bytes is not bricked.
 */
export const neverBricked: Invariant = {
  id: "k.never-bricked",
  description: "at least one slot always holds runnable bytes (about slots, not liveness)",
  check: (s) =>
    s.slots.stable === null && s.slots.experiment === null
      ? "both slots empty — nothing left to run"
      : null,
};

/**
 * A live incarnation's version matches the slot it was started from.
 * Only constrains processes K started; slots reporting null are ignored.
 */
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

/**
 * After promote/rollback the experiment slot is cleared. This is about the
 * TRANSACTION's own bookkeeping, not about whether a restart has happened yet.
 */
export const terminalLeavesNoExperiment: Invariant = {
  id: "k.terminal-leaves-no-experiment",
  description: "after promote/rollback the experiment slot is cleared",
  check: (s) =>
    (s.phase === "promoted" || s.phase === "rolled-back") && s.slots.experiment !== null
      ? `phase ${s.phase} but experiment slot still holds ${s.slots.experiment}`
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
export const WORKLOAD_PRESERVED_ASSUMES: readonly HostAssumption[] = ["quiesce-resume-inverse"];

export function workloadPreserved(before: WorldSnapshot, after: WorldSnapshot): InvariantResult {
  if (before.workloadDigest === undefined || after.workloadDigest === undefined) return null;
  return before.workloadDigest === after.workloadDigest
    ? null
    : `workload digest changed across the transition: ${before.workloadDigest} -> ${after.workloadDigest}`;
}
