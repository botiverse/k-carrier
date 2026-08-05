// @invariant — receipt fail-closed rule: an empty check list is NEVER a
// pass ("0 checks" and "all passed" must be distinguishable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReceipt, printReceipt } from "./receipt.ts";

test("an empty check list renders as fail, never pass", () => {
  const r = buildReceipt({ mode: "profile", profile: "cli", target: null, checks: [] });
  assert.equal(r.result, "fail");
  assert.deepEqual(r.summary, { pass: 0, fail: 0, na: 0, total: 0 });
});

test("any fail dominates, and pass/na mix renders pass", () => {
  const fail = buildReceipt({
    mode: "profile",
    profile: "cli",
    target: null,
    checks: [
      { id: "a", status: "pass", error: null, durationMs: 1 },
      { id: "b", status: "fail", error: "X", durationMs: 1 },
    ],
  });
  assert.equal(fail.result, "fail");
  const pass = buildReceipt({
    mode: "profile",
    profile: "cli",
    target: null,
    checks: [
      { id: "a", status: "pass", error: null, durationMs: 1 },
      { id: "b", status: "na", error: null, durationMs: 1 },
    ],
  });
  assert.equal(pass.result, "pass");
});

test("human receipt lines state the result and the check marks", () => {
  const r = buildReceipt({
    mode: "profile",
    profile: "cli",
    target: null,
    checks: [
      { id: "a", status: "pass", error: null, durationMs: 5 },
      { id: "b", status: "fail", error: "HARNESS_EMPTY_SELECTION: none", durationMs: 5 },
    ],
  });
  const lines: string[] = [];
  printReceipt(r, false, (l) => lines.push(l));
  assert.ok(lines.some((l) => l.includes("✔ a")));
  assert.ok(lines.some((l) => l.includes("✖ b") && l.includes("HARNESS_EMPTY_SELECTION")));
  assert.ok(lines.some((l) => l.includes("result: fail")));
});
