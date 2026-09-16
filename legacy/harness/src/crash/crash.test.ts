// @invariant — the crash matrix is the load-bearing guarantee: every
// enumerated point must recover without violating any invariant, and the
// coverage itself must be generated (never hand-listed).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enumerateCrashPoints,
  uncoveredTransitions,
  malformedPoints,
  CRASH_INSTANTS,
} from "./enumerate.ts";
import { runCrashPoint } from "./runner.ts";
import { TRANSITIONS, phasesInTable } from "../../../core/src/txn/transitions.ts";

test("coverage is generated from the transition table, not hand-listed", () => {
  const points = enumerateCrashPoints();
  assert.equal(points.length, TRANSITIONS.length * CRASH_INSTANTS.length);
  assert.deepEqual(uncoveredTransitions(points), []);
  assert.deepEqual(malformedPoints(points), []);
});

test("completeness: every phase in the machine appears in the matrix", () => {
  const points = enumerateCrashPoints();
  const inMatrix = new Set(points.flatMap((p) => [p.transition.from, p.transition.to]));
  for (const phase of phasesInTable()) {
    assert.ok(inMatrix.has(phase), `phase ${phase} has no crash coverage`);
  }
});

test("EVERY enumerated crash point recovers with zero invariant violations", async () => {
  const failures: string[] = [];
  for (const point of enumerateCrashPoints()) {
    const result = await runCrashPoint(point);
    if (result.violationsAfterRecovery.length > 0) {
      failures.push(
        `${point.id}: ${result.violationsAfterRecovery.map((v) => `${v.invariantId} (${v.reason})`).join("; ")}`,
      );
    }
  }
  assert.deepEqual(failures, [], `crash points left the world in a violating state:\n${failures.join("\n")}`);
});

test("recovery always lands on a terminal-safe phase (never mid-transition)", async () => {
  for (const point of enumerateCrashPoints()) {
    const result = await runCrashPoint(point);
    assert.ok(
      ["idle", "promoted", "rolled-back"].includes(result.finalPhase),
      `${point.id} recovered into non-terminal phase ${result.finalPhase}`,
    );
  }
});

test("the matrix actually crashes where it says (no silently-inert points)", async () => {
  // If a point never fires, its "recovery" proves nothing — this catches a
  // matrix that has gone vacuous (e.g. after refactoring the engine).
  const inert: string[] = [];
  for (const point of enumerateCrashPoints()) {
    const result = await runCrashPoint(point);
    if (!result.crashed) inert.push(point.id);
  }
  assert.deepEqual(inert, [], `crash points never fired: ${inert.join(", ")}`);
});
