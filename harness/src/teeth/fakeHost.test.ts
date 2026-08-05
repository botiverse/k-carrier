// @invariant — fake-host teeth self-verification: known-green on a clean
// world, and every fault switch really turns its tooth red (switch off ->
// green). This is the §1.1 discipline: a tooth must test the fault, not
// the norm.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./fakeHost.ts"; // registers the teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkLedgerEquivalence,
  checkLedgerEquivalenceAfterRollback,
  checkQuiesceCompletes,
  checkStopCompletes,
  checkProbeVersionMatchesSlot,
  checkProbeBindsCurrentIncarnation,
  checkStartCompletes,
} from "../fake-host/checks.ts";
import type { FakeHostFaults } from "../fake-host/inproc.ts";

const TOOTH_IDS = new Set([
  "fake-host.ledger-equivalence",
  "fake-host.ledger-equivalence-after-rollback",
  "fake-host.fault-fail-on-quiesce",
  "fake-host.fault-hang-on-stop",
  "fake-host.fault-wrong-version-probe",
  "fake-host.fault-stale-startid-probe",
  "fake-host.fault-crash-during-start",
]);

async function ctxFor(prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "managed", sandboxDir: sb.dir }, teardown: sb.teardown };
}

// ---------------------------------------------------------------------------
// known-green: all teeth pass with every fault switch OFF
// ---------------------------------------------------------------------------

test("known-green: every fake-host tooth passes with faults off", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 7, "all fake-host teeth must be registered");
  for (const tooth of teeth) {
    const { ctx, teardown } = await ctxFor(tooth.id.replaceAll(".", "-"));
    try {
      await tooth.run(ctx);
    } catch (err) {
      assert.fail(`tooth ${tooth.id} went RED with faults off: ${(err as Error).message}`);
    } finally {
      await teardown();
    }
  }
});

// ---------------------------------------------------------------------------
// known-red: each fault switch really turns its tooth red
// ---------------------------------------------------------------------------

const FAULT_SWITCHES: Array<{
  id: string;
  run: (ctx: ToothContext, faults: FakeHostFaults) => Promise<void>;
  faults: FakeHostFaults;
}> = [
  { id: "fault-fail-on-quiesce", run: checkQuiesceCompletes, faults: { failOnQuiesce: true } },
  { id: "fault-hang-on-stop", run: checkStopCompletes, faults: { hangOnStop: true } },
  { id: "fault-wrong-version-probe", run: checkProbeVersionMatchesSlot, faults: { wrongVersionProbe: true } },
  { id: "fault-stale-startid-probe", run: checkProbeBindsCurrentIncarnation, faults: { staleStartIdProbe: true } },
  { id: "fault-crash-during-start", run: checkStartCompletes, faults: { crashDuringStart: true } },
];

test("known-red: every fault switch turns its tooth red", async () => {
  for (const { id, run, faults } of FAULT_SWITCHES) {
    const { ctx, teardown } = await ctxFor(id.replaceAll(".", "-"));
    try {
      let red = false;
      try {
        await run(ctx, faults);
      } catch {
        red = true;
      }
      assert.equal(red, true, `tooth fake-host.${id} must go red with its fault switch on`);
    } finally {
      await teardown();
    }
  }
});

test("known-red: the ledger teeth catch a broken quiesce/resume path", async () => {
  const q = await ctxFor("red-quiesce");
  try {
    await assert.rejects(
      checkLedgerEquivalence(q.ctx, { failOnQuiesce: true }),
      /fail-on-quiesce/,
    );
  } finally {
    await q.teardown();
  }
  const r = await ctxFor("red-rollback-probe");
  try {
    // a lying probe mid-handover must break the rollback equivalence flow
    await assert.rejects(
      checkLedgerEquivalenceAfterRollback(r.ctx, { wrongVersionProbe: true }),
      /its own version/,
    );
  } finally {
    await r.teardown();
  }
});

// ---------------------------------------------------------------------------
// registration discipline
// ---------------------------------------------------------------------------

test("registration discipline: profiles/layers/kind/mustRed all answered", () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  for (const tooth of teeth) {
    assert.ok(tooth.profiles.length > 0, `${tooth.id}: profiles`);
    assert.ok(tooth.layers.length > 0, `${tooth.id}: layers`);
    assert.equal(tooth.kind.kind, "invariant", `${tooth.id}: kind`);
    assert.ok(tooth.mustRed.length > 0, `${tooth.id}: must-red`);
    for (const mr of tooth.mustRed) {
      assert.ok(mr.mutate.trim(), `${tooth.id}: mutation text`);
      assert.ok(
        mr.caughtOnlyBy === "this" ||
          (mr.caughtOnlyBy.alsoCaughtBy.trim() && mr.caughtOnlyBy.whyStillNeeded.trim()),
        `${tooth.id}: caughtOnlyBy answered`,
      );
    }
  }
  const exported = new Map(exportForMutationRunner().map((e) => [e.id, e]));
  for (const id of TOOTH_IDS) {
    assert.ok(exported.has(id), `${id} must be in the mutation-runner export`);
  }
});

test("fake-host teeth are daemon/managed only (L2/L3 is out of cli tier)", () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  for (const tooth of teeth) {
    assert.ok(!tooth.profiles.includes("cli"), `${tooth.id} must not tag cli (tier boundary)`);
    assert.ok(tooth.profiles.includes("daemon") && tooth.profiles.includes("managed"));
  }
});

test("tooth run functions are the exported checks (single source of truth)", () => {
  const byId = new Map(allTeeth().map((t) => [t.id, t] as const));
  assert.equal(byId.get("fake-host.ledger-equivalence")!.run, checkLedgerEquivalence);
  assert.equal(byId.get("fake-host.ledger-equivalence-after-rollback")!.run, checkLedgerEquivalenceAfterRollback);
  assert.equal(byId.get("fake-host.fault-fail-on-quiesce")!.run, checkQuiesceCompletes);
  assert.equal(byId.get("fake-host.fault-hang-on-stop")!.run, checkStopCompletes);
  assert.equal(byId.get("fake-host.fault-wrong-version-probe")!.run, checkProbeVersionMatchesSlot);
  assert.equal(byId.get("fake-host.fault-stale-startid-probe")!.run, checkProbeBindsCurrentIncarnation);
  assert.equal(byId.get("fake-host.fault-crash-during-start")!.run, checkStartCompletes);
});
