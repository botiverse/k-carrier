// @invariant — quarantine is an atomic state handoff, never deletion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { quarantineState, QuarantineError } from "./quarantine.ts";
import { persistOperation, type OperationRecord } from "./operation.ts";
import { acquireUpgradeLock } from "./txn/lock.ts";
import { bootstrapStable } from "./bootstrap.ts";

async function fixture(): Promise<{ root: string; state: string; destination: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "k-quarantine-"));
  const state = path.join(root, "computer", "k");
  const destination = path.join(root, "computer", "k-quarantine", "op-1-100");
  await fs.mkdir(path.join(state, "slots", "stable"), { recursive: true });
  await fs.writeFile(path.join(state, "slots", "stable", "VERSION"), "1.0.0\n");
  await fs.writeFile(path.join(state, "journal.jsonl"), "audit\n");
  return { root, state, destination };
}

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    formatVersion: 1,
    id: "op-1",
    startedAtMs: 1,
    updatedAtMs: 2,
    fromVersion: "1.0.0",
    targetVersion: "2.0.0",
    previousStableVersion: "1.0.0",
    phase: "failed",
    outcome: "failed",
    reason: "download failed",
    provenance: null,
    metadata: {},
    acknowledgedAtMs: null,
    ...overrides,
  };
}

test("quarantine atomically moves terminal state and preserves an audit receipt", async () => {
  const { state, destination } = await fixture();
  await persistOperation(state, operation());
  const result = await quarantineState(state, { destination, timestampMs: 100 });
  assert.equal(result.status, "quarantined");
  assert.equal(result.operationId, "op-1");
  await assert.rejects(() => fs.stat(state), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(destination, "journal.jsonl"), "utf8"), "audit\n");
  const receipt = JSON.parse(await fs.readFile(path.join(destination, "fresh-install-quarantine.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(receipt, {
    formatVersion: 1,
    kind: "k-fresh-install-quarantine",
    sourcePath: path.resolve(state),
    quarantinePath: path.resolve(destination),
    operationId: "op-1",
    timestampMs: 100,
  });
});

test("active operation remains fail-closed until the host confirms handoff", async () => {
  const { state, destination } = await fixture();
  await persistOperation(state, operation({ phase: "handing-over", outcome: null }));
  await assert.rejects(
    () => quarantineState(state, { destination, timestampMs: 100 }),
    (error: unknown) => error instanceof QuarantineError && error.code === "QUARANTINE_ACTIVE_OPERATION",
  );
  const result = await quarantineState(state, { destination, timestampMs: 101, assertActiveHandoff: async () => {} });
  assert.equal(result.status, "quarantined");
});

test("active handoff proof failure leaves the state untouched", async () => {
  const { state, destination } = await fixture();
  await persistOperation(state, operation({ phase: "handing-over", outcome: null }));
  await assert.rejects(
    () => quarantineState(state, { destination, timestampMs: 100, assertActiveHandoff: async () => { throw new Error("old pid alive"); } }),
    (error: unknown) => error instanceof QuarantineError && error.code === "QUARANTINE_ACTIVE_OPERATION",
  );
  assert.equal(await fs.readFile(path.join(state, "journal.jsonl"), "utf8"), "audit\n");
});

test("a live lock owner is never bypassed", async () => {
  const { state, destination } = await fixture();
  const lock = await acquireUpgradeLock(state, 1);
  try {
    await assert.rejects(
      () => quarantineState(state, { destination, timestampMs: 100 }),
      (error: unknown) => error instanceof QuarantineError && error.code === "QUARANTINE_ACTIVE_LOCK",
    );
  } finally {
    await lock.release();
  }
});

test("replay returns the original durable quarantine receipt", async () => {
  const { state, destination } = await fixture();
  await persistOperation(state, operation());
  const first = await quarantineState(state, { destination, timestampMs: 100 });
  const second = await quarantineState(state, { destination, timestampMs: 999 });
  assert.deepEqual(second, { ...first, status: "already-quarantined" });
});

test("fresh bootstrap can initialize a new state after quarantine", async () => {
  const { root, state, destination } = await fixture();
  await persistOperation(state, operation());
  await quarantineState(state, { destination, timestampMs: 100 });
  const candidate = path.join(root, "candidate.bin");
  await fs.writeFile(candidate, "candidate-bytes");
  assert.equal(await bootstrapStable({ stateDir: state, version: "2.0.0", artifactPath: candidate, nowMs: () => 101 }), "bootstrapped");
  assert.equal(await fs.readFile(path.join(state, "slots", "stable", "VERSION"), "utf8"), "2.0.0");
  assert.equal(await fs.readFile(path.join(destination, "slots", "stable", "VERSION"), "utf8"), "1.0.0\n");
});

test("unreadable operation state fails closed", async () => {
  const { state, destination } = await fixture();
  await fs.writeFile(path.join(state, "operation.json"), "not-json\n");
  await assert.rejects(
    () => quarantineState(state, { destination, timestampMs: 100 }),
    (error: unknown) => error instanceof QuarantineError && error.code === "QUARANTINE_STATE_UNREADABLE",
  );
  assert.equal(await fs.readFile(path.join(state, "journal.jsonl"), "utf8"), "audit\n");
});

test("destination conflicts are not overwritten", async () => {
  const { state, destination } = await fixture();
  await fs.mkdir(destination, { recursive: true });
  await assert.rejects(
    () => quarantineState(state, { destination, timestampMs: 100 }),
    (error: unknown) => error instanceof QuarantineError && error.code === "QUARANTINE_DESTINATION_CONFLICT",
  );
  assert.equal(await fs.readFile(path.join(state, "journal.jsonl"), "utf8"), "audit\n");
});
