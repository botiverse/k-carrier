// @invariant — receipt fail-closed rule: an empty check list is NEVER a
// pass ("0 checks" and "all passed" must be distinguishable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReceipt, printReceipt } from "./receipt.ts";

test("an empty check list renders as fail, never pass", () => {
  const r = buildReceipt({ mode: "profile", profile: "swap", target: null, checks: [] });
  assert.equal(r.result, "fail");
  assert.deepEqual(r.summary, { pass: 0, fail: 0, na: 0, total: 0 });
});

test("any fail dominates, and pass/na mix renders pass", () => {
  const fail = buildReceipt({
    mode: "profile",
    profile: "swap",
    target: null,
    checks: [
      { id: "a", status: "pass", error: null, durationMs: 1 },
      { id: "b", status: "fail", error: "X", durationMs: 1 },
    ],
  });
  assert.equal(fail.result, "fail");
  const pass = buildReceipt({
    mode: "profile",
    profile: "swap",
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
    profile: "swap",
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

test("THE POINT: a receipt where nothing executed is not a pass", () => {
  // All-`na` is the empty suite in disguise: checks.length looks healthy while
  // zero of them verified anything. Found while reviewing adapter mode, where
  // an adapter that declares a marker can drive every check to `na`.
  const receipt = buildReceipt({
    mode: "adapter",
    profile: "service",
    target: "./somewhere",
    checks: [
      { id: "a", status: "na", error: null, durationMs: 0 },
      { id: "b", status: "na", error: null, durationMs: 0 },
    ],
    startedAtMs: 0,
    durationMs: 0,
  });
  assert.equal(receipt.summary.na, 2);
  assert.equal(receipt.result, "fail", "zero executed checks cannot be green");
});

test("a receipt with a real pass and some inapplicable checks IS a pass", () => {
  // The counterpart: `na` is legitimate for checks that do not apply to a
  // profile, so it must not poison an otherwise real result.
  const receipt = buildReceipt({
    mode: "adapter",
    profile: "service",
    target: "./somewhere",
    checks: [
      { id: "a", status: "pass", error: null, durationMs: 1 },
      { id: "b", status: "na", error: null, durationMs: 0 },
    ],
    startedAtMs: 0,
    durationMs: 0,
  });
  assert.equal(receipt.result, "pass");
});
