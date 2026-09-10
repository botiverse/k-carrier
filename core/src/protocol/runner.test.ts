/** @invariant Unsupported requests cannot reach host code. */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRunnerRequest } from "./runner.ts";
test("runner protocol rejects unknown fields and versions", () => {
  assert.deepEqual(parseRunnerRequest({ protocolVersion: 1, action: "recover" }), { protocolVersion: 1, action: "recover" });
  assert.throws(() => parseRunnerRequest({ protocolVersion: 2, action: "recover" }), /UNSUPPORTED/);
  assert.throws(() => parseRunnerRequest({ protocolVersion: 1, action: "recover", extra: true }), /unknown field/);
});

test("unknown request cannot run an adapter factory", async () => {
  const { serveRunner } = await import("../runner/cli.ts");
  const { Readable, Writable } = await import("node:stream");
  let created = false;
  let output = "";
  const exit = await serveRunner(() => { created = true; throw new Error("factory reached"); },
    Readable.from([JSON.stringify({ protocolVersion: 99, action: "recover" })]),
    new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } }));
  assert.equal(created, false);
  assert.equal(exit, 1);
  assert.match(output, /RUNNER_PROTOCOL_UNSUPPORTED/);
});
