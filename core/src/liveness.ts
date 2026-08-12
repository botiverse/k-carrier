/**
 * Liveness and progress — deliberately NOT in invariants.ts.
 *
 * Everything in the safety set there is satisfied by a host that does nothing
 * at all: a DEAD service violates none of them (never-bricked judges slots,
 * live-process-matches-slot is vacuous with nothing alive, the rest read
 * journals). Safety therefore cannot say an updater works. These two functions
 * are what says it, and they are judged over time rather than over one
 * snapshot, which is exactly why they do not fit the Invariant shape.
 */
import type { TxnPhase } from "./txn/state.ts";
import type { WorldSnapshot, InvariantResult, HostAssumption } from "./invariants.ts";

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

/**
 * PROGRESS, and the reason it cannot be a plain invariant.
 *
 * Every safety invariant above is satisfied by a host with NO live process:
 * `never-bricked` is about slots (its own description says so),
 * `live-process-matches-slot` is vacuous when nothing is live, and the journal
 * ones only look at journals. So a service that is simply DEAD passes the
 * entire safety set — which is the "doing nothing satisfies safety" hole, in
 * our own code.
 *
 * What an adopter actually needs promised (once session
 * preservation was ruled out): *you always come back*. That is a liveness
 * property, and it needs two things a single snapshot cannot give:
 *   - TIME: right after a terminal phase nothing is live yet; starting takes a
 *     moment. Judging one instant would fail a healthy upgrade.
 *   - OBSERVATION: it must be checkable from outside, from the same status
 *     readback anyone else can take — not from our internal logs.
 *
 * So it is expressed over a sequence of observed snapshots: once the
 * transaction is terminal, some later observation within the budget must show
 * a live incarnation running the stable slot's version.
 */
export const SERVICE_SETTLES_LIVE_ASSUMES: readonly HostAssumption[] = ["resident-service"];

export function serviceSettlesLive(
  observations: readonly WorldSnapshot[],
  maxObservations: number,
): InvariantResult {
  const terminal = new Set<TxnPhase>(["idle", "promoted", "rolled-back"]);
  const firstTerminal = observations.findIndex((s) => terminal.has(s.phase));
  if (firstTerminal === -1) return null; // still in flight: reachesTerminalWithin judges that
  const after = observations.slice(firstTerminal, firstTerminal + maxObservations);
  for (const s of after) {
    const expected = s.slots.stable;
    if (expected === null) continue;
    if (s.liveProcesses.some((p) => p.version === expected)) return null;
  }
  const last = after.at(-1);
  const seen =
    last === undefined || last.liveProcesses.length === 0
      ? "nothing live"
      : last.liveProcesses.map((p) => p.version).join(", ");
  return (
    `transaction settled at ${observations[firstTerminal]!.phase} but no live process reports the ` +
    `stable version ${last?.slots.stable ?? "unknown"} within ${maxObservations} observations (saw: ${seen})`
  );
}
