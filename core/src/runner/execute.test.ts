/** @invariant Errors and missing evidence cannot manufacture upgrade success or rollback. */
import test from "node:test";
import assert from "node:assert/strict";
import { executeRequest } from "./execute.ts";
const base = (outcome: "up-to-date" | "held" | "rolled-back") => ({
  operation: async () => ({ kind: "genesis" as const }),
  recover: async () => {},
  upgradeTo: async () => outcome === "up-to-date" ? { result: "up-to-date" as const } : outcome === "held" ? { result: "held" as const, reason: "policy" } : { result: "rolled-back" as const, reason: "bad", report: null },
});
test("runner refuses success without a matching durable receipt", async () => {
  assert.equal((await executeRequest(base("up-to-date"), { protocolVersion: 1, action: "upgrade", id: "a", targetVersion: "2", consented: true })).exitCode, 1);
  assert.equal((await executeRequest(base("held"), { protocolVersion: 1, action: "upgrade", id: "b", targetVersion: "2", consented: true })).exitCode, 2);
  assert.equal((await executeRequest(base("rolled-back"), { protocolVersion: 1, action: "upgrade", id: "c", targetVersion: "2", consented: true })).exitCode, 1);
});

test("a thrown operation never manufactures a rolled-back receipt", async () => {
  const result = await executeRequest({ ...base("held"), upgradeTo: async () => { throw new Error("controller disappeared"); } },
    { protocolVersion: 1, action: "upgrade", id: "error", targetVersion: "2", consented: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.result, "failed");
  assert.deepEqual(result.operation, { kind: "genesis" });
  assert.equal(result.error, "controller disappeared");
});
