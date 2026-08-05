// @invariant — determinism rules of the scenario clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "./virtualClock.ts";

test("time only moves via advance; timers fire in due order, FIFO among equals", () => {
  const c = new VirtualClock();
  const fired: string[] = [];
  c.after(10, () => fired.push("b"));
  c.after(5, () => fired.push("a"));
  c.after(10, () => fired.push("c")); // same due as b, scheduled later
  assert.equal(c.nowMs(), 0);
  c.advance(4);
  assert.deepEqual(fired, []);
  c.advance(10);
  assert.deepEqual(fired, ["a", "b", "c"]);
  assert.equal(c.nowMs(), 14);
});

test("callbacks scheduling within the advanced window fire in the same advance", () => {
  const c = new VirtualClock();
  const fired: string[] = [];
  c.after(5, () => {
    fired.push("first");
    c.after(3, () => fired.push("chained")); // due at 8, inside window
    c.after(100, () => fired.push("outside")); // due at 105, outside
  });
  c.advance(20);
  assert.deepEqual(fired, ["first", "chained"]);
  assert.equal(c.pendingCount(), 1);
});

test("cancel prevents firing", () => {
  const c = new VirtualClock();
  const fired: string[] = [];
  const cancel = c.after(5, () => fired.push("x"));
  cancel();
  c.advance(10);
  assert.deepEqual(fired, []);
  assert.equal(c.pendingCount(), 0);
});
