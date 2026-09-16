// @invariant — M0 exit gate: the harness may not judge until it proves it
// can judge, including against a sample built to slip past its own checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSelfVerification, promotedVersionIsLive } from "./selfVerify.ts";
import { BUILT_IN_INVARIANTS } from "../../../core/src/invariants.ts";

const FULL_SET = [...BUILT_IN_INVARIANTS, promotedVersionIsLive];

test("M0 EXIT GATE: harness qualifies on all three samples", () => {
  const outcome = runSelfVerification(FULL_SET);
  assert.equal(outcome.knownGreen, "passed", `false alarm: ${outcome.detail.join("; ")}`);
  assert.equal(outcome.knownRed, "caught", `missed seeded defect: ${outcome.detail.join("; ")}`);
  assert.equal(outcome.adversarial, "caught", `adversarial escape: ${outcome.detail.join("; ")}`);
  assert.ok(outcome.qualified, outcome.detail.join("; "));
});

test("the adversarial sample DOES escape the built-ins alone (it is a real trap, not theatre)", () => {
  // Without the oracle that catches it, the adversarial world looks perfectly
  // healthy to every structural invariant. This is what makes sample #3
  // meaningful: it was designed to pass the checks that existed.
  const outcome = runSelfVerification(BUILT_IN_INVARIANTS);
  assert.equal(outcome.adversarial, "passed", "adversarial sample must be a genuine escape without its oracle");
  assert.equal(outcome.qualified, false, "harness must refuse to qualify while an escape is open");
});

test("the fresh-incarnation oracle is quiet on healthy worlds (no false alarms)", () => {
  assert.equal(
    promotedVersionIsLive.check({
      phase: "promoted",
      slots: { stable: "2.0.0", experiment: null },
      liveProcesses: [{ slot: "stable", pid: 1, startId: "s-AFTER", version: "2.0.0" }],
      journalIntents: ["promoted"],
      priorIncarnationStartId: "s-BEFORE",
    }),
    null,
  );
  // and silent in phases where it does not apply
  assert.equal(
    promotedVersionIsLive.check({
      phase: "staged",
      slots: { stable: "1.0.0", experiment: "2.0.0" },
      liveProcesses: [{ slot: "stable", pid: 1, startId: "s1", version: "1.0.0" }],
      journalIntents: ["staged"],
    }),
    null,
  );
});

test("an unqualified harness reports WHY, not just that it failed", () => {
  const outcome = runSelfVerification(BUILT_IN_INVARIANTS);
  assert.ok(outcome.detail.length > 0, "must explain the escape");
  assert.match(outcome.detail.join(" "), /adversarial ESCAPED/);
});
