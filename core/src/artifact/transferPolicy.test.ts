// @invariant — production transfer time has three independent bounds: a
// response budget, a no-progress budget, and a size-derived overall ceiling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactTransferTimeouts } from "./transferPolicy.ts";

const POLICY = {
  responseTimeoutMs: 2_000,
  idleTimeoutMs: 3_000,
  minimumBytesPerSecond: 1_000,
  maximumOverallTimeoutMs: 20_000,
};

test("overall transfer budget grows with authority-provided artifact size", () => {
  assert.deepEqual(artifactTransferTimeouts(4_000, POLICY), {
    responseTimeoutMs: 2_000,
    idleTimeoutMs: 3_000,
    overallTimeoutMs: 6_000,
  });
  assert.deepEqual(artifactTransferTimeouts(8_000, POLICY), {
    responseTimeoutMs: 2_000,
    idleTimeoutMs: 3_000,
    overallTimeoutMs: 10_000,
  });
});

test("size-derived transfer budget remains under an explicit hard ceiling", () => {
  assert.equal(artifactTransferTimeouts(1_000_000, POLICY).overallTimeoutMs, 20_000);
});

test("invalid or unbounded transfer policies fail closed", () => {
  assert.throws(() => artifactTransferTimeouts(0, POLICY), /ARTIFACT_TRANSFER_POLICY_INVALID/u);
  assert.throws(
    () => artifactTransferTimeouts(1, { ...POLICY, idleTimeoutMs: 0 }),
    /ARTIFACT_TRANSFER_POLICY_INVALID/u,
  );
  assert.throws(
    () => artifactTransferTimeouts(1, { ...POLICY, maximumOverallTimeoutMs: 1_000 }),
    /ARTIFACT_TRANSFER_POLICY_INVALID/u,
  );
});
