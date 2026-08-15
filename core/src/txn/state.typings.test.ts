// @invariant — illegal TxnState combinations are unrepresentable at the type
// level: terminal phases never carry an experiment, in-flight phases always
// do, and only rolled-back carries a reason (compile-time half of
// k.terminal-leaves-no-experiment / k.live-process-matches-slot).
// Each `@ts-expect-error` below asserts the compiler REJECTS an invalid
// construction: if the union regressed to a flat type, tsc would error on the
// now-unjustified `@ts-expect-error`.
import { test } from "node:test";
import assert from "node:assert";
import { buildTxnState, type TxnState } from "./state.ts";

// Positive: every valid member is representable and discriminable.
const idleState: TxnState = { phase: "idle", stableVersion: "1.0.0", experimentVersion: null, rollbackReason: null };
const inflightState: TxnState = { phase: "staged", stableVersion: "1.0.0", experimentVersion: "2.0.0", rollbackReason: null };
const promotedState: TxnState = { phase: "promoted", stableVersion: "2.0.0", experimentVersion: null, rollbackReason: null };
const rolledBackState: TxnState = { phase: "rolled-back", stableVersion: "1.0.0", experimentVersion: null, rollbackReason: "probe failed" };

void idleState;
void inflightState;
void promotedState;
void rolledBackState;

// Negative (compiler must REJECT each):
//  terminal phase carrying an experiment  =>  k.terminal-leaves-no-experiment as a type error
// @ts-expect-error -- terminal phase must not carry an experiment
const badPromoted: TxnState = { phase: "promoted", stableVersion: "2.0.0", experimentVersion: "2.0.0", rollbackReason: null };
void badPromoted;

// @ts-expect-error -- idle must not carry an experiment
const badIdle: TxnState = { phase: "idle", stableVersion: "1.0.0", experimentVersion: "0.9.0", rollbackReason: null };
void badIdle;

//  in-flight phase with no experiment  =>  must always carry one
// @ts-expect-error -- in-flight phase must carry an experiment
const badInflight: TxnState = { phase: "readback", stableVersion: "1.0.0", experimentVersion: null, rollbackReason: null };
void badInflight;

//  only `rolled-back` may carry a reason
// @ts-expect-error -- only rolled-back may carry a rollbackReason
const badReason: TxnState = { phase: "promoted", stableVersion: "2.0.0", experimentVersion: null, rollbackReason: "nope" };
void badReason;

// Exhaustive narrowing: a switch over phase must be able to read the
// experiment ONLY on in-flight members without error (proves the union
// discriminates correctly). TS would error below if any member were missing.
function describeInFlightExperiment(s: TxnState): string | null {
  switch (s.phase) {
    case "idle":
    case "promoted":
    case "rolled-back":
      return null;
    case "staged":
    case "handing-over":
    case "running-experiment":
    case "readback":
      return s.experimentVersion; // only this branch may read a string experiment
  }
}

// buildTxnState preserves soundness through the on-disk boundary.
test("buildTxnState builds discriminated members from discriminate input", () => {
  assert.deepStrictEqual(buildTxnState({ phase: "promoted", stableVersion: "2.0.0" }), {
    phase: "promoted",
    stableVersion: "2.0.0",
    experimentVersion: null,
    rollbackReason: null,
  });
  assert.deepStrictEqual(buildTxnState({ phase: "rolled-back", stableVersion: "1.0.0", rollbackReason: "boom" }), {
    phase: "rolled-back",
    stableVersion: "1.0.0",
    experimentVersion: null,
    rollbackReason: "boom",
  });
  assert.deepStrictEqual(buildTxnState({ phase: "readback", stableVersion: "1.0.0", experimentVersion: "2.0.0" }), {
    phase: "readback",
    stableVersion: "1.0.0",
    experimentVersion: "2.0.0",
    rollbackReason: null,
  });

  // The union discriminates: in-flight members expose the experiment as a
  // string, terminal members expose null (see describeInFlightExperiment).
  assert.strictEqual(describeInFlightExperiment(inflightState), "2.0.0");
  assert.strictEqual(describeInFlightExperiment(promotedState), null);
  assert.strictEqual(describeInFlightExperiment(rolledBackState), null);
  assert.strictEqual(describeInFlightExperiment(idleState), null);
});

// buildTxnState's *input* is strongly typed too: an illegal argument
// combination is a compile error, not silently coerced.
// @ts-expect-error -- terminal phase cannot be given an experiment
const badInputPromoted = buildTxnState({ phase: "promoted", stableVersion: "2.0.0", experimentVersion: "2.0.0" });
void badInputPromoted;

// @ts-expect-error -- in-flight phase must be given an experiment
const badInputInflight = buildTxnState({ phase: "readback", stableVersion: "1.0.0" });
void badInputInflight;

// @ts-expect-error -- only rolled-back may carry a rollbackReason
const badInputReason = buildTxnState({ phase: "promoted", stableVersion: "2.0.0", rollbackReason: "nope" });
void badInputReason;
