// @invariant — the recovery decision is now a value an adopter can read
// without K acting. Every intent must map to exactly one action, and the
// mapping must stay identical to what recover() executes: a second copy of
// this logic on the adopter's side would drift, and the drift would surface
// as fake divergences during migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecovery } from "./recoveryDecision.ts";
import type { JournalEntry } from "./state.ts";

const entry = (intent: string): JournalEntry =>
  ({ seq: 0, timestampMs: 1, intent } as unknown as JournalEntry);

test("no journal is a fresh install, not an error", () => {
  assert.deepEqual(decideRecovery(undefined, null), { kind: "nothing", reason: "fresh-install" });
});

test("terminal intents redo only when the slot still holds something", () => {
  // The redo obligation exists because the intent is durable while its action
  // may not have run. With an empty slot the action already took effect.
  assert.deepEqual(decideRecovery(entry("promoted"), "2.0.0"), { kind: "redo-promote" });
  assert.deepEqual(decideRecovery(entry("promoted"), null), { kind: "nothing", reason: "already-settled" });
  assert.deepEqual(decideRecovery(entry("rolled-back"), "2.0.0"), { kind: "redo-clear" });
  assert.deepEqual(decideRecovery(entry("rolled-back"), null), { kind: "nothing", reason: "already-settled" });
});

test("staged is a cheap undo — the host was never touched", () => {
  assert.deepEqual(decideRecovery(entry("staged"), "2.0.0"), { kind: "undo-staged" });
});

test("in-flight WITH an experiment asks for evidence, never a planned-restart flag", () => {
  for (const intent of ["handing-over", "running-experiment", "readback"]) {
    assert.deepEqual(decideRecovery(entry(intent), "2.0.0"), {
      kind: "needs-evidence",
      intent,
      experimentVersion: "2.0.0",
    });
  }
});

test("in-flight WITHOUT an experiment rolls back — it does not refuse", () => {
  // Refusing here would strand a machine recover() has always been able to
  // settle. There is simply no evidence to weigh, which is not the same as
  // being unable to act.
  for (const intent of ["handing-over", "running-experiment", "readback"]) {
    assert.deepEqual(decideRecovery(entry(intent), null), { kind: "rollback-in-flight", intent });
  }
});

test("an intent from a NEWER core refuses rather than guessing", () => {
  const action = decideRecovery(entry("quarantined"), "2.0.0");
  assert.equal(action.kind, "refuse");
  assert.match((action as { reason: string }).reason, /newer than binary/);
});
