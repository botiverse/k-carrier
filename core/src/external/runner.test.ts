/** @baseline */
import test from "node:test";
import assert from "node:assert/strict";
import { runOneShotUpgrade } from "./runner.ts";
const base = (outcome: "up-to-date" | "held" | "rolled-back") => ({
  operation: async () => ({ kind: "genesis" as const }),
  acknowledgeOperation: async () => "not-found" as const,
  recover: async () => {},
  upgradeTo: async () => outcome === "up-to-date" ? { result: "up-to-date" as const } : outcome === "held" ? { result: "held" as const, reason: "policy" } : { result: "rolled-back" as const, reason: "bad", report: null },
});
test("runner returns refuses success without a matching durable receipt", async () => {
  assert.equal((await runOneShotUpgrade(base("up-to-date"), { protocolVersion: 1, action: "upgrade", id: "a", targetVersion: "2", consented: true })).exitCode, 1);
  assert.equal((await runOneShotUpgrade(base("held"), { protocolVersion: 1, action: "upgrade", id: "b", targetVersion: "2", consented: true })).exitCode, 2);
  assert.equal((await runOneShotUpgrade(base("rolled-back"), { protocolVersion: 1, action: "upgrade", id: "c", targetVersion: "2", consented: true })).exitCode, 1);
});
