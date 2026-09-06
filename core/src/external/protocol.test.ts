/** @baseline */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRunnerRequest } from "./protocol.ts";
test("runner protocol rejects unknown fields and versions", () => {
  assert.deepEqual(parseRunnerRequest({ protocolVersion: 1, action: "recover" }), { protocolVersion: 1, action: "recover" });
  assert.throws(() => parseRunnerRequest({ protocolVersion: 2, action: "recover" }), /UNSUPPORTED/);
  assert.throws(() => parseRunnerRequest({ protocolVersion: 1, action: "recover", extra: true }), /unknown field/);
});
