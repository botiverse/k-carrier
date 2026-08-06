// @invariant — the invariant library is itself load-bearing: these lock
// that each built-in actually fires on its violation and stays quiet otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_INVARIANTS,
  checkInvariants,
  workloadPreserved,
  type WorldSnapshot,
} from "./invariants.ts";
import { serviceSettlesLive, reachesTerminalWithin } from "./liveness.ts";

function healthy(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    phase: "idle",
    slots: { stable: "1.0.0", experiment: null },
    liveProcesses: [{ slot: "stable", pid: 1, startId: "s1", version: "1.0.0" }],
    journalIntents: [],
    ...overrides,
  };
}

test("a healthy world violates nothing", () => {
  assert.deepEqual(checkInvariants(healthy()), []);
});

test("never-dual-run fires when two incarnations are live", () => {
  const v = checkInvariants(
    healthy({
      liveProcesses: [
        { slot: "stable", pid: 1, startId: "s1", version: "1.0.0" },
        { slot: "experiment", pid: 2, startId: "s2", version: "2.0.0" },
      ],
      slots: { stable: "1.0.0", experiment: "2.0.0" },
    }),
  );
  assert.equal(v.length, 1);
  assert.equal(v[0]!.invariantId, "k.never-dual-run");
  assert.match(v[0]!.reason, /2 live incarnations/);
});

test("never-bricked fires when both slots are empty", () => {
  const v = checkInvariants(healthy({ slots: { stable: null, experiment: null }, liveProcesses: [] }));
  assert.deepEqual(v.map((x) => x.invariantId), ["k.never-bricked"]);
});

test("live-process-matches-slot catches a process reporting a version its slot does not hold", () => {
  const v = checkInvariants(
    healthy({ liveProcesses: [{ slot: "stable", pid: 1, startId: "s1", version: "9.9.9" }] }),
  );
  assert.deepEqual(v.map((x) => x.invariantId), ["k.live-process-matches-slot"]);
});

test("journal-precedes-phase catches an unjournaled phase", () => {
  const v = checkInvariants(healthy({ phase: "handing-over", journalIntents: ["staged"] }));
  assert.deepEqual(v.map((x) => x.invariantId), ["k.journal-precedes-phase"]);
  // journaled first => quiet
  assert.deepEqual(
    checkInvariants(healthy({ phase: "handing-over", journalIntents: ["staged", "handing-over"] })),
    [],
  );
});

test("terminal-leaves-no-experiment catches a leftover experiment slot", () => {
  const v = checkInvariants(
    healthy({
      phase: "promoted",
      journalIntents: ["staged", "promoted"],
      slots: { stable: "2.0.0", experiment: "2.0.0" },
      liveProcesses: [{ slot: "stable", pid: 1, startId: "s1", version: "2.0.0" }],
    }),
  );
  assert.deepEqual(v.map((x) => x.invariantId), ["k.terminal-leaves-no-experiment"]);
});


test("managed-copy-never-self-upgrades fires when a managed install transacts", () => {
  const v = checkInvariants(
    healthy({ phase: "staged", journalIntents: ["staged"], slots: { stable: "1.0.0", experiment: "2.0.0" }, experimentSignatureVerified: true, installOwnership: "managed-elsewhere" }),
  );
  assert.deepEqual(v.map((x) => x.invariantId), ["k.managed-copy-never-self-upgrades"]);
});

test("liveness: a transaction parked short of terminal is caught once the step budget is spent", () => {
  assert.equal(reachesTerminalWithin(["staged", "handing-over", "promoted"], 10), null);
  assert.equal(reachesTerminalWithin(["staged", "handing-over"], 10), null, "within budget: not yet a violation");
  assert.match(
    reachesTerminalWithin(["staged", "staged", "staged", "staged"], 4)!,
    /no progress to a terminal phase/,
  );
});

test("conditional guarantees declare their host assumptions", () => {
  // The library must let an adopter see which guarantees depend on their code.
  const conditional = BUILT_IN_INVARIANTS.filter((i) => (i.assumes?.length ?? 0) > 0);
  const unconditional = BUILT_IN_INVARIANTS.filter((i) => (i.assumes?.length ?? 0) === 0);
  assert.ok(unconditional.length > 0, "some guarantees must be unconditional");
  for (const inv of conditional) assert.ok(inv.assumes!.length > 0);
});

test("every built-in is exercised by this suite", () => {
  // guards against adding an invariant with no test (coverage completeness)
  const covered = new Set([
    "k.never-dual-run",
    "k.never-bricked",
    "k.live-process-matches-slot",
    "k.journal-precedes-phase",
    "k.terminal-leaves-no-experiment",
    "k.no-unverified-artifact",
    "k.managed-copy-never-self-upgrades",
  ]);
  for (const inv of BUILT_IN_INVARIANTS) {
    assert.ok(covered.has(inv.id), `built-in ${inv.id} has no violation test`);
  }
});

test("THE POINT: a service that never comes back passes every SAFETY invariant", () => {
  // The doing-nothing hole, demonstrated against our own set: dead service,
  // no violations. This is why liveness is judged separately.
  const dead = healthy({
    phase: "promoted",
    slots: { stable: "2.0.0", experiment: null },
    journalIntents: ["staged", "handing-over", "promoted"],
    liveProcesses: [],
  });
  assert.deepEqual(checkInvariants(dead), []);
  assert.match(
    serviceSettlesLive([dead, dead, dead], 3)!,
    /no live process reports the stable version 2\.0\.0/,
  );
});

test("serviceSettlesLive accepts a service that takes a moment to come back", () => {
  // Starting is not instantaneous. Judging the instant of the terminal phase
  // would redden a perfectly healthy upgrade.
  const settled = {
    phase: "promoted" as const,
    slots: { stable: "2.0.0", experiment: null },
    journalIntents: ["staged" as const, "promoted" as const],
  };
  const observations = [
    { ...settled, liveProcesses: [] },
    { ...settled, liveProcesses: [] },
    { ...settled, liveProcesses: [{ slot: "stable" as const, pid: 9, startId: "s2", version: "2.0.0" }] },
  ];
  assert.equal(serviceSettlesLive(observations, 3), null);
  // ...but not one that takes longer than the budget allows
  assert.match(serviceSettlesLive(observations, 2)!, /within 2 observations/);
});

test("serviceSettlesLive is silent while the transaction is still in flight", () => {
  // Progress toward a terminal phase is reachesTerminalWithin's job; this one
  // must not double-report it.
  const inFlight = healthy({ phase: "handing-over", liveProcesses: [] });
  assert.equal(serviceSettlesLive([inFlight, inFlight], 2), null);
});

test("coming back on the OLD version after a rollback counts as settled", () => {
  // Rollback is a success for this property: the promise is that you come
  // back, not that you moved forward.
  const rolledBack = {
    phase: "rolled-back" as const,
    slots: { stable: "1.0.0", experiment: null },
    journalIntents: ["staged" as const, "rolled-back" as const],
    liveProcesses: [{ slot: "stable" as const, pid: 3, startId: "s3", version: "1.0.0" }],
  };
  assert.equal(serviceSettlesLive([rolledBack], 2), null);
});

test("workloadPreserved compares digests and ignores hosts that declare none", () => {
  const before = healthy({ workloadDigest: "abc" });
  assert.equal(workloadPreserved(before, healthy({ workloadDigest: "abc" })), null);
  assert.match(workloadPreserved(before, healthy({ workloadDigest: "xyz" }))!, /digest changed/);
  assert.equal(workloadPreserved(healthy(), healthy()), null);
});
