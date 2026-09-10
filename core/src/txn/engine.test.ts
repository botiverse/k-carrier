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
  slots?: Record<Slot, string | null>;
  clock?: { nowMs: () => number; after: (ms: number, fn: () => void) => () => void };
} = {}) {
  const trace: string[] = [];
  let probes = 0; // every probe answers as a fresh incarnation unless a test says otherwise
  const journal: JournalEntry[] = opts.journal ? [...opts.journal] : [];
  const slots: Record<Slot, string | null> = opts.slots
    ? { ...opts.slots }
    : { stable: opts.stable ?? "1.0.0", experiment: null };
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
        return { version: "2.0.0", pid: 42, startId: `s-${++probes}` };
      }),
      resume: async () => { trace.push("host:resume"); },
    },
    clock: opts.clock ?? { nowMs: () => clockMs++, after: () => () => {} },
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
    "host:probe", // baseline: which incarnation is being replaced
    "journal:staged", "slots:stage",
    "journal:handing-over", "host:quiesce", "host:stop:stable", "host:start:experiment",
    "journal:running-experiment", "host:probe",
    "journal:readback",
    "journal:promoted", "slots:promote", "host:resume",
  ]);
  assert.equal(w.slots.stable, "2.0.0");
  assert.equal(w.slots.experiment, null);
});

/** Probe answering first as the pre-upgrade incarnation, then as `after`. */
const thenProbe = (after: () => Promise<ProcessEvidence>) => {
  let calls = 0;
  return async () => calls++ === 0 ? { version: "1.0.0", pid: 42, startId: "old-1" } : after();
};

test("the pre-handover startId is journaled; the SAME incarnation at readback rolls back", async () => {
  const bound = makeWorld({ probe: thenProbe(async () => ({ version: "2.0.0", pid: 9, startId: "new-2" })) });
  await new UpgradeEngine(bound.deps).upgrade({ version: "2.0.0", bytesRef: "ref" });
  assert.equal(bound.journal.find((e) => e.intent === "handing-over")?.detail.priorStartId, "old-1");
  // stop() returned but nothing was replaced: the old process now claims the
  // target version. The version check passes; only the incarnation catches it.
  const same = makeWorld({ probe: thenProbe(async () => ({ version: "2.0.0", pid: 42, startId: "old-1" })) });
  const outcome = await new UpgradeEngine(same.deps).upgrade({ version: "2.0.0", bytesRef: "ref" });
  assert.equal(outcome.result, "rolled-back");
  assert.match((outcome as { reason: string }).reason, /pre-upgrade incarnation/);
  assert.equal(same.slots.stable, "1.0.0");
});

test("no baseline when nothing runs before the upgrade; a wedged baseline stops before handover", async () => {
  let calls = 0;
  const idle = makeWorld({ probe: async () => {
    if (calls++ === 0) throw new Error("connection refused");
    return { version: "2.0.0", pid: 9, startId: "fresh" };
  } });
  assert.deepEqual(await new UpgradeEngine(idle.deps).upgrade({ version: "2.0.0", bytesRef: "ref" }), { result: "promoted", version: "2.0.0" });
  assert.equal(idle.journal.find((e) => e.intent === "handing-over")?.detail.priorStartId, undefined);
  const wedged = makeWorld({ probe: () => new Promise<ProcessEvidence>(() => {}),
    clock: { nowMs: () => 1, after: (_ms, fn) => { const h = setTimeout(fn, 1); return () => clearTimeout(h); } } });
  await assert.rejects(new UpgradeEngine({ ...wedged.deps, hostCallBudgetMs: 5 }).upgrade({ version: "2.0.0", bytesRef: "ref" }), /healthProbe/);
  assert.deepEqual(wedged.trace.filter((x) => x.startsWith("host:")), [], "no handover effects after a wedged baseline");
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

test("THE POINT: a host that HANGS fails the upgrade instead of hanging it", async () => {
  // The wedged-half-way failure: worse than a crash, because the
  // process stays ALIVE holding the lock, so stale-lock takeover never fires
  // and every later attempt queues behind it forever.
  const w = makeWorld({
    probe: thenProbe(() => new Promise<ProcessEvidence>(() => {})), // readback probe never settles
    // The budget is virtual (5s); this fires it after a real millisecond so
    // the test does not actually wait, and only the call that never answers
    // reaches its deadline.
    clock: {
      nowMs: () => 1000,
      after: (_ms, fn) => {
        const t = setTimeout(fn, 1);
        return () => clearTimeout(t);
      },
    },
  });
  const engine = new UpgradeEngine({ ...w.deps, hostCallBudgetMs: 5_000 });
  await assert.rejects(
    engine.upgrade({ version: "2.0.0", bytesRef: "ref" }),
    /healthProbe\(\) did not return within 5000ms/,
    "a wedge must end the attempt, not hang it",
  );
  // ...and it must NOT have gone on to drive a host it just declared wedged:
  // stop/start/resume against a host that never answered is how one stuck
  // upgrade becomes two live incarnations.
  assert.deepEqual(
    w.trace.filter((t) => t.startsWith("host:")),
    ["host:quiesce", "host:stop:stable", "host:start:experiment"], // custom probes do not trace
    "no host calls after the wedge",
  );
});

/** World where the runner died mid-handover, before promote intent. */
const handedOver = (opts: Parameters<typeof makeWorld>[0]) => makeWorld({ slots: { stable: "1.0.0", experiment: "2.0.0" },
  journal: [entry(0, "staged"), entry(1, "handing-over", { version: "2.0.0", priorStartId: "old-1" })], ...opts });

test("a handover that outlived its driver rolls back conservatively", async () => {
  // The runner died before promote intent. Even a healthy candidate cannot
  // authorize commitment; recovery must restore the stable slot.
  const w = handedOver({ probe: async () => ({ version: "2.0.0", pid: 99, startId: "new-2" }) });
  await new UpgradeEngine(w.deps).recover();
  assert.deepEqual(w.trace, ["journal:rolled-back", "host:stop:experiment", "host:start:stable", "host:resume", "slots:clear"]);
  assert.equal(w.slots.stable, "1.0.0");
  assert.equal(w.slots.experiment, null);
});

test("THE POINT: the SAME incarnation reporting the new version is not a handover", async () => {
  // Nothing was replaced -- the old process is still the live one and merely
  // claims the target version. A "restart was planned" flag could not tell
  // this apart; the incarnation identity can.
  const w = handedOver({ probe: async () => ({ version: "2.0.0", pid: 42, startId: "old-1" }) });
  await new UpgradeEngine(w.deps).recover();
  assert.deepEqual(w.trace, ["journal:rolled-back", "host:stop:experiment", "host:start:stable", "host:resume", "slots:clear"]);
  assert.equal(w.slots.stable, "1.0.0");
});

test("a successor running the OLD version, or nothing alive, rolls back", async () => {
  const probes: Array<() => Promise<ProcessEvidence>> = [
    async () => ({ version: "1.0.0", pid: 99, startId: "new-2" }), async () => { throw new Error("no socket"); }];
  for (const probe of probes) {
    const w = handedOver({ probe });
    await new UpgradeEngine(w.deps).recover();
    assert.equal(w.trace[0], "journal:rolled-back");
    assert.equal(w.slots.stable, "1.0.0");
  }
});

test("a successor cannot promote past the host's own predicates", async () => {
  const w = handedOver({ probe: async () => ({ version: "2.0.0", pid: 99, startId: "new-2" }), predicates: async () => "sessions did not come back" });
  await new UpgradeEngine(w.deps).recover();
  assert.equal(w.trace.at(-1), "slots:clear");
  assert.equal(w.slots.stable, "1.0.0");
});

test("recover after crash at staged: cheap undo, no host restart", async () => {
  const w = makeWorld({ journal: [entry(0, "staged")] });
  await new UpgradeEngine(w.deps).recover();
  assert.deepEqual(w.trace, ["journal:rolled-back", "slots:clear"]);
});

test("recover after promoted intent always resumes parked work; next seq continues", async () => {
  const w = makeWorld({ journal: [entry(0, "staged"), entry(1, "promoted")] });
  const engine = new UpgradeEngine(w.deps);
  await engine.recover();
  assert.deepEqual(w.trace, ["slots:promote", "host:resume"]);
  await engine.upgrade({ version: "3.0.0", bytesRef: "r" });
  assert.equal(w.journal.at(2)!.seq, 2); // seq continues after replay
});

test("recover after promoted WAL but before slot action redoes promote then resume", async () => {
  const w = makeWorld({
    slots: { stable: "1.0.0", experiment: "2.0.0" },
    journal: [entry(0, "staged"), entry(1, "promoted")],
  });
  await new UpgradeEngine(w.deps).recover();
  assert.deepEqual(w.trace, ["slots:promote", "host:resume"]);
  assert.deepEqual(w.slots, { stable: "2.0.0", experiment: null });
});

test("recover after rolled-back WAL redoes host restore before clearing experiment", async () => {
  const w = makeWorld({
    slots: { stable: "1.0.0", experiment: "2.0.0" },
    journal: [entry(0, "staged"), entry(1, "readback"), entry(2, "rolled-back")],
  });
  await new UpgradeEngine(w.deps).recover();
  assert.deepEqual(w.trace, [
    "host:stop:experiment",
    "host:start:stable",
    "host:resume",
    "slots:clear",
  ]);
  assert.deepEqual(w.slots, { stable: "1.0.0", experiment: null });
});

test("recover fails closed on a journal intent from a newer core", async () => {
  const w = makeWorld({ journal: [entry(0, "staged"), entry(1, "quantum-staged" as JournalEntry["intent"])] });
  await assert.rejects(() => new UpgradeEngine(w.deps).recover(), /not understood by this core/);
  assert.deepEqual(w.trace, []); // refused to act
});

const never = (): Promise<never> => new Promise(() => {});
for (const mode of ["resume", "readback", "recovery-stop", "recovery-start", "recovery-resume", "fence"] as const) {
  test(`completion budget covers ${mode} and issues no later effects`, async () => {
    const recovering = mode.startsWith("recovery") || mode === "fence";
    const w = makeWorld({
      ...(recovering ? { journal: [entry(0, "handing-over")] } : {}),
      clock: { nowMs: () => 1, after: (_ms, fn) => {
        const timer = setTimeout(fn, 10); return () => clearTimeout(timer);
      } },
    });
    switch (mode) {
      case "resume": case "recovery-resume": w.deps.host.resume = never; break;
      case "readback": w.deps.evaluatePredicates = never; break;
      case "recovery-stop": w.deps.host.stop = never; break;
      case "recovery-start": w.deps.host.start = never; break;
      case "fence": w.deps.host.fence = never; break;
    }
    const engine = new UpgradeEngine({ ...w.deps, hostCallBudgetMs: 10 });
    await assert.rejects(recovering ? engine.recover() : engine.upgrade({ version: "2.0.0", bytesRef: "x" }), /did not return within/);
    assert.ok(!w.trace.includes("slots:clear"), "uncertain recovery must retain its experiment/evidence");
    if (mode === "fence") assert.deepEqual(w.trace, [], "no mutation before controller isolation");
    if (mode === "readback") assert.ok(!w.trace.includes("slots:promote"));
  });
}
