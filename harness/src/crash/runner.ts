/**
 * Crash runner — drives the REAL engine to an enumerated crash point, kills
 * it there, then runs recovery on a fresh engine over the same durable state
 * and asserts the invariants (harness-design §1.4).
 *
 * "Kill" is modelled by throwing from inside the effect at the chosen
 * instant: the engine's in-memory state dies, only journaled/durable state
 * survives — exactly what a kill -9 leaves behind. (The real-process tier
 * repeats this against a spawned daemon; the logic tier runs every point
 * cheaply and deterministically.)
 */
import { UpgradeEngine, type EngineDeps } from "../../../core/src/txn/engine.ts";
import type { JournalEntry, TxnPhase } from "../../../core/src/txn/state.ts";
import type { Slot, ProcessEvidence } from "../../../core/src/lifecycle/hostAdapter.ts";
import { checkInvariants, type Violation, type WorldSnapshot } from "../../../core/src/invariants.ts";
import type { CrashPoint } from "./enumerate.ts";

class SimulatedCrash extends Error {
  constructor(pointId: string) {
    super(`simulated crash at ${pointId}`);
    this.name = "SimulatedCrash";
  }
}

interface DurableWorld {
  journal: JournalEntry[];
  slots: { stable: string | null; experiment: string | null };
}

export interface CrashRunResult {
  point: CrashPoint;
  crashed: boolean;
  violationsAtCrash: Violation[];
  violationsAfterRecovery: Violation[];
  finalPhase: TxnPhase;
}

function snapshot(world: DurableWorld, live: WorldSnapshot["liveProcesses"]): WorldSnapshot {
  const intents = world.journal.map((e) => e.intent);
  return {
    phase: intents.at(-1) ?? "idle",
    slots: { ...world.slots },
    liveProcesses: live,
    journalIntents: intents,
  };
}

/**
 * Run one crash point end to end.
 * targetPhase/instant decide where the injected failure fires.
 */
export async function runCrashPoint(point: CrashPoint): Promise<CrashRunResult> {
  // Durable state survives the crash; in-memory engine state does not.
  const world: DurableWorld = { journal: [], slots: { stable: "1.0.0", experiment: null } };
  let live: WorldSnapshot["liveProcesses"] = [
    { slot: "stable", pid: 100, startId: "s-100", version: "1.0.0" },
  ];
  let crashed = false;
  let startCounter = 100;

  const targetIntent = point.transition.to;
  // A crash point on a rollback edge can only fire if the run actually
  // rolls back, so drive predicates to refuse for those points.
  const rollbackScenario = point.transition.to === "rolled-back";
  const shouldCrash = (instant: CrashPoint["instant"], intent: TxnPhase): boolean =>
    !crashed && intent === targetIntent && instant === point.instant;

  const makeDeps = (armed: boolean): EngineDeps => ({
    effects: {
      journal: {
        appendAndSync: async (entry) => {
          if (armed && shouldCrash("before-journal", entry.intent)) {
            crashed = true;
            throw new SimulatedCrash(point.id);
          }
          world.journal.push(entry);
          if (armed && shouldCrash("after-journal", entry.intent)) {
            crashed = true;
            throw new SimulatedCrash(point.id);
          }
        },
        readAll: async () => [...world.journal],
      },
      slots: {
        stageExperiment: async (a) => {
          world.slots.experiment = a.version;
          maybeCrashAfterAction("staged");
        },
        slotVersions: async () => ({ ...world.slots }),
        promoteExperiment: async () => {
          world.slots.stable = world.slots.experiment;
          world.slots.experiment = null;
          maybeCrashAfterAction("promoted");
        },
        clearExperiment: async () => {
          world.slots.experiment = null;
        },
      },
    },
    host: {
      quiesce: async () => {},
      stop: async () => {
        live = [];
      },
      start: async (slot: Slot) => {
        startCounter += 1;
        const version = world.slots[slot];
        live = version === null ? [] : [{ slot, pid: startCounter, startId: `s-${startCounter}`, version }];
        maybeCrashAfterAction(slot === "experiment" ? "handing-over" : "rolled-back");
      },
      healthProbe: async (): Promise<ProcessEvidence> => {
        const p = live.at(0);
        if (!p) throw new Error("no live process to probe");
        const evidence = { version: p.version, pid: p.pid, startId: p.startId };
        maybeCrashAfterAction("running-experiment");
        return evidence;
      },
      resume: async () => {},
    },
    clock: { nowMs: () => world.journal.length, after: () => () => {} },
    evaluatePredicates: async () => {
      maybeCrashAfterAction("readback");
      // Rollback edges are only reachable when predicates refuse; the
      // scenario is chosen by the crash point being exercised.
      return rollbackScenario ? "predicates refused (scenario)" : null;
    },
  });

  function maybeCrashAfterAction(intent: TxnPhase): void {
    if (shouldCrash("after-action", intent)) {
      crashed = true;
      throw new SimulatedCrash(point.id);
    }
  }

  // Phase 1: run until the injected crash (or completion).
  try {
    await new UpgradeEngine(makeDeps(true)).upgrade({ version: "2.0.0", bytesRef: "ref" });
  } catch (err) {
    if (!(err instanceof SimulatedCrash)) throw err;
  }
  const violationsAtCrash = checkInvariants(snapshot(world, live));

  // Phase 2: fresh process over the same durable state -> recover.
  const recovered = new UpgradeEngine(makeDeps(false));
  await recovered.recover();
  const after = snapshot(world, live);

  return {
    point,
    crashed,
    violationsAtCrash,
    violationsAfterRecovery: checkInvariants(after),
    finalPhase: after.phase,
  };
}
