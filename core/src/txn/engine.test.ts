// @invariant — engine core guarantees: WAL ordering, rollback symmetry,
// crash recovery decided by journal, fail-closed on unknown journal intent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UpgradeEngine, type EngineDeps } from "./engine.ts";
import type { JournalEntry } from "./state.ts";
import type { Slot, ProcessEvidence } from "../lifecycle/hostAdapter.ts";

/** Shared trace records journal appends AND effects/host ops in real order,
 * so WAL ("intent before action") is assertable, not assumed. */
function makeWorld(opts: {
  probe?: () => Promise<ProcessEvidence>;
  predicates?: (e: ProcessEvidence, v: string) => Promise<string | null>;
  journal?: JournalEntry[];
  stable?: string | null;
} = {}) {
  const trace: string[] = [];
  const journal: JournalEntry[] = opts.journal ? [...opts.journal] : [];
  const slots: Record<Slot, string | null> = { stable: opts.stable ?? "1.0.0", experiment: null };
  let clockMs = 1000;

  const deps: EngineDeps = {
    effects: {
      journal: {
        appendAndSync: async (e) => {
          journal.push(e);
          trace.push(`journal:${e.intent}`);
        },
        readAll: async () => [...journal],
      },
      slots: {
        stageExperiment: async (a) => {
          slots.experiment = a.version;
          trace.push("slots:stage");
        },
        slotVersions: async () => ({ ...slots }),
        promoteExperiment: async () => {
          slots.stable = slots.experiment;
          slots.experiment = null;
          trace.push("slots:promote");
        },
        clearExperiment: async () => {
          slots.experiment = null;
          trace.push("slots:clear");
        },
      },
    },
    host: {
      quiesce: async () => { trace.push("host:quiesce"); },
      stop: async (slot) => { trace.push(`host:stop:${slot}`); },
      start: async (slot) => { trace.push(`host:start:${slot}`); },
      healthProbe: opts.probe ?? (async () => {
        trace.push("host:probe");
        return { version: "2.0.0", pid: 42, startId: "s-42" };
      }),
      resume: async () => { trace.push("host:resume"); },
    },
    clock: { nowMs: () => clockMs++, after: () => () => {} },
    evaluatePredicates: opts.predicates ?? (async () => null),
  };
  return { deps, trace, journal, slots };
}

test("happy path: staged->handover->readback->promoted, WAL before every action", async () => {
  const w = makeWorld();
  const engine = new UpgradeEngine(w.deps);
  const outcome = await engine.upgrade({ version: "2.0.0", bytesRef: "ref" });
  assert.deepEqual(outcome, { result: "promoted", version: "2.0.0" });
  assert.deepEqual(w.trace, [
    "journal:staged", "slots:stage",
    "journal:handing-over", "host:quiesce", "host:stop:stable", "host:start:experiment",
    "journal:running-experiment", "host:probe",
    "journal:readback",
    "journal:promoted", "slots:promote", "host:resume",
  ]);
  assert.equal(w.slots.stable, "2.0.0");
  assert.equal(w.slots.experiment, null);
});

test("predicate refusal rolls back: stable restored, experiment cleared, reason journaled", async () => {
  const w = makeWorld({ predicates: async () => "probe version mismatch" });
  const engine = new UpgradeEngine(w.deps);
  const outcome = await engine.upgrade({ version: "2.0.0", bytesRef: "ref" });
  assert.equal(outcome.result, "rolled-back");
  assert.match((outcome as { reason: string }).reason, /probe version mismatch/);
  const tail = w.trace.slice(w.trace.indexOf("journal:rolled-back"));
  assert.deepEqual(tail, ["journal:rolled-back", "host:stop:experiment", "host:start:stable", "host:resume", "slots:clear"]);
  assert.equal(w.slots.stable, "1.0.0");
  assert.equal(w.slots.experiment, null);
});

test("probe failure rolls back", async () => {
  const w = makeWorld({ probe: async () => { throw new Error("no socket"); } });
  const engine = new UpgradeEngine(w.deps);
  const outcome = await engine.upgrade({ version: "2.0.0", bytesRef: "ref" });
  assert.equal(outcome.result, "rolled-back");
  assert.match((outcome as { reason: string }).reason, /no socket/);
});

test("up-to-date short-circuits with zero side effects", async () => {
  const w = makeWorld({ stable: "2.0.0" });
  const outcome = await new UpgradeEngine(w.deps).upgrade({ version: "2.0.0", bytesRef: "r" });
  assert.deepEqual(outcome, { result: "up-to-date" });
  assert.deepEqual(w.trace, []);
});

function entry(seq: number, intent: JournalEntry["intent"], detail: Record<string, string> = {}): JournalEntry {
  return { seq, timestampMs: seq, intent, detail };
}

test("recover after crash mid-handover: rolls back with host restart", async () => {
  const w = makeWorld({ journal: [entry(0, "staged"), entry(1, "handing-over")] });
  await new UpgradeEngine(w.deps).recover();
  assert.deepEqual(w.trace, ["journal:rolled-back", "host:stop:experiment", "host:start:stable", "host:resume", "slots:clear"]);
});

test("recover after crash at staged: cheap undo, no host restart", async () => {
  const w = makeWorld({ journal: [entry(0, "staged")] });
  await new UpgradeEngine(w.deps).recover();
  assert.deepEqual(w.trace, ["journal:rolled-back", "slots:clear"]);
});

test("recover on terminal journal: no side effects; next seq continues", async () => {
  const w = makeWorld({ journal: [entry(0, "staged"), entry(1, "promoted")] });
  const engine = new UpgradeEngine(w.deps);
  await engine.recover();
  assert.deepEqual(w.trace, []);
  await engine.upgrade({ version: "3.0.0", bytesRef: "r" });
  assert.equal(w.journal.at(2)!.seq, 2); // seq continues after replay
});

test("recover fails closed on a journal intent from a newer core", async () => {
  const w = makeWorld({ journal: [entry(0, "staged"), entry(1, "quantum-staged" as JournalEntry["intent"])] });
  await assert.rejects(() => new UpgradeEngine(w.deps).recover(), /not understood by this core/);
  assert.deepEqual(w.trace, []); // refused to act
});
