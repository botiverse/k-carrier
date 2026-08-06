// @invariant — status report unit invariants: every field is a read-back
// of its live source, and a machine that never observed a promote reports
// NOT_OBSERVED (null), never a fabricated pass. The harness teeth drive the
// real upgrader status(); this file pins the pure builder's contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport, type StatusReport } from "./report.ts";
import type { TxnState } from "../txn/state.ts";
import type { ConvergenceReport } from "../converge/predicates.ts";
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

test("every field is the live source's value, verbatim", () => {
  const r = buildStatusReport({ state, lastReport: null, policy: "confirm", provenance });
  assert.equal(r.phase, "idle");
  assert.equal(r.stable, "1.0.0");
  assert.equal(r.experiment, null);
  assert.equal(r.policy, "confirm");
  assert.equal(r.provenance, provenance);
});

test("no report yet => both predicates are NOT_OBSERVED (null), never fabricated", () => {
  const r = buildStatusReport({ state, lastReport: null, policy: "auto", provenance });
  assert.equal(r.predicates.binaryAtTarget, null, "never evaluated => null, not passed:true");
  assert.equal(r.predicates.hostLifecycleConverged, null, "never evaluated => null, not passed:true");
});

test("a real report's predicates are carried, verbatim", () => {
  const report: ConvergenceReport = {
    binaryAtTarget: { passed: true, source: "host.healthProbe", observedAtMs: 1, detail: { version: "2.0.0" } },
    hostLifecycleConverged: { passed: true, source: "test.autostart", observedAtMs: 1, detail: {} },
  };
  const r = buildStatusReport({ state, lastReport: report, policy: "auto", provenance });
  assert.deepEqual(r.predicates.binaryAtTarget, report.binaryAtTarget);
  assert.deepEqual(r.predicates.hostLifecycleConverged, report.hostLifecycleConverged);
});

test("a rolled-back reconcile leaves no report => predicates stay NOT_OBSERVED", () => {
  const r = buildStatusReport({ state, lastReport: null, policy: "auto", provenance });
  assert.equal(r.predicates.hostLifecycleConverged, null);
});

test("an app that never wired a journal reports provenance null (config-level absence)", () => {
  const r = buildStatusReport({ state, lastReport: null, policy: "auto", provenance: null });
  assert.equal(r.provenance, null);
});

test("genesis vs unreadable provenance is carried through, never reclassified", () => {
  const genesis: StatusReport = buildStatusReport({
    state,
    lastReport: null,
    policy: "auto",
    provenance: { kind: "genesis" },
  });
  assert.equal(genesis.provenance!.kind, "genesis");
  const unreadable: StatusReport = buildStatusReport({
    state,
    lastReport: null,
    policy: "auto",
    provenance: { kind: "unreadable", reason: "EACCES" },
  });
  assert.equal(unreadable.provenance!.kind, "unreadable");
});
