// @invariant — status report unit invariants: every field is a read-back
// of its live source, the predicates are a THREE-state read (genesis /
// unreadable / observed — an unreadable report is never "never observed"),
// and a machine that never observed a promote is NOT_OBSERVED, never a
// fabricated pass. The harness teeth drive the real upgrader status();
// this file pins the pure builder's contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "./report.ts";
import type { TxnState } from "../txn/state.ts";
import type { ReportRead } from "./reportStore.ts";
import type { ProvenanceRead } from "../provenance/journal.ts";

const state: TxnState = {
  phase: "idle",
  stableVersion: "1.0.0",
  experimentVersion: null,
  rollbackReason: null,
};

const provenance: ProvenanceRead = {
  kind: "observed",
  entries: [{ seq: 0, who: "a", carrier: "c", when: 1, version: "1.0.0" }],
};

const observed: ReportRead = {
  kind: "observed",
  report: {
    version: "2.0.0",
    binaryAtTarget: { passed: true, source: "host.healthProbe", observedAtMs: 1, detail: { version: "2.0.0" } },
    hostLifecycleConverged: { passed: true, source: "test.autostart", observedAtMs: 1, detail: {} },
  },
};

test("every field is the live source's value, verbatim", () => {
  const r = buildStatusReport({ state, lastReport: observed, policy: "confirm", provenance });
  assert.equal(r.phase, "idle");
  assert.equal(r.stable, "1.0.0");
  assert.equal(r.experiment, null);
  assert.equal(r.policy, "confirm");
  assert.equal(r.provenance, provenance);
});

test("never promoted => predicates are genesis (NOT_OBSERVED), never a fabricated pass", () => {
  const r = buildStatusReport({ state, lastReport: { kind: "genesis" }, policy: "auto", provenance });
  assert.equal(r.predicates.kind, "genesis");
});

test("an unreadable report is its own state — never genesis, never observed", () => {
  const r = buildStatusReport({
    state,
    lastReport: { kind: "unreadable", reason: "EACCES" },
    policy: "auto",
    provenance,
  });
  assert.equal(r.predicates.kind, "unreadable", "cannot read is not never-observed");
  if (r.predicates.kind === "unreadable") assert.ok(r.predicates.reason.length > 0);
});

test("a real report's predicates are carried, verbatim, with the version join key", () => {
  const r = buildStatusReport({ state, lastReport: observed, policy: "auto", provenance });
  assert.equal(r.predicates.kind, "observed");
  if (r.predicates.kind !== "observed") return;
  assert.equal(r.predicates.version, "2.0.0");
  assert.deepEqual(r.predicates.binaryAtTarget, observed.report.binaryAtTarget);
  assert.deepEqual(r.predicates.hostLifecycleConverged, observed.report.hostLifecycleConverged);
});

test("an app that never wired a journal reports provenance null (config-level absence)", () => {
  const r = buildStatusReport({ state, lastReport: observed, policy: "auto", provenance: null });
  assert.equal(r.provenance, null);
});

test("genesis vs unreadable provenance is carried through, never reclassified", () => {
  const genesis = buildStatusReport({ state, lastReport: observed, policy: "auto", provenance: { kind: "genesis" } });
  assert.equal(genesis.provenance!.kind, "genesis");
  const unreadable = buildStatusReport({
    state,
    lastReport: observed,
    policy: "auto",
    provenance: { kind: "unreadable", reason: "EACCES" },
  });
  assert.equal(unreadable.provenance!.kind, "unreadable");
});
