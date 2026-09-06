import test from "node:test";
import assert from "node:assert/strict";
import { runOneShotUpgrade } from "./oneShot.ts";
import type { Upgrader } from "./upgrader.ts";
function fake(result: Awaited<ReturnType<Upgrader["upgradeTo"]>>): Upgrader {
  return { check: async () => ({ current: "1", target: "2" }), upgrade: async () => result, upgradeTo: async () => result, rollback: async () => "rolled-back", retireLegacyManager: async () => "retired", state: async () => ({ phase: "idle", stableVersion: "1", experimentVersion: undefined, rollbackReason: null }), status: async () => ({}) as never };
}
test("one-shot maps terminal outcomes to shell status", async () => {
  assert.equal((await runOneShotUpgrade(fake({ result: "up-to-date" }), "2")).exitCode, 0);
  assert.equal((await runOneShotUpgrade(fake({ result: "held", reason: "policy" }), "2")).exitCode, 2);
  assert.equal((await runOneShotUpgrade(fake({ result: "rolled-back", reason: "bad", report: null }), "2")).exitCode, 1);
});
