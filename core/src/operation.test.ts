// @invariant — K's operation receipt is the only durable transaction status
// a host may project, so corrupt/future/active records must fail closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acknowledgeOperation,
  loadOperation,
  persistOperation,
  type OperationRecord,
} from "./operation.ts";

async function stateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "k-operation-"));
}

function record(): OperationRecord {
  return {
    formatVersion: 1,
    id: "op-1",
    startedAtMs: 1,
    updatedAtMs: 2,
    fromVersion: "1.0.0",
    targetVersion: "2.0.0",
    previousStableVersion: "1.0.0",
    phase: "promoted",
    outcome: "promoted",
    reason: null,
    provenance: { who: "server-1", carrier: "web" },
    metadata: { originServerId: "server-1" },
    acknowledgedAtMs: null,
  };
}

test("operation receipt is durable and acknowledgement binds the exact terminal id", async () => {
  const dir = await stateDir();
  await persistOperation(dir, record());
  assert.deepEqual(await loadOperation(dir), { kind: "observed", operation: record() });

  assert.equal(await acknowledgeOperation(dir, "other", 3), "changed");
  assert.equal(await acknowledgeOperation(dir, "op-1", 3), "acknowledged");
  const after = await loadOperation(dir);
  assert.equal(after.kind, "observed");
  if (after.kind === "observed") assert.equal(after.operation.acknowledgedAtMs, 3);

  assert.equal(await acknowledgeOperation(dir, "op-1", 9), "acknowledged");
  const replayed = await loadOperation(dir);
  assert.equal(replayed.kind, "observed");
  if (replayed.kind === "observed") {
    assert.equal(
      replayed.operation.acknowledgedAtMs,
      3,
      "an exact replay must preserve the first durable acknowledgement time",
    );
    assert.equal(replayed.operation.updatedAtMs, 3);
  }
});

test("an active operation cannot be acknowledged as if it were terminal", async () => {
  const dir = await stateDir();
  await persistOperation(dir, { ...record(), phase: "handing-over", outcome: null });
  assert.equal(await acknowledgeOperation(dir, "op-1", 3), "not-terminal");
});

test("corrupt operation is unreadable, never genesis", async () => {
  const dir = await stateDir();
  await fs.writeFile(path.join(dir, "operation.json"), "{broken", "utf8");
  const read = await loadOperation(dir);
  assert.equal(read.kind, "unreadable");
});

test("unknown operation phase is unreadable, never treated as a terminal receipt", async () => {
  const dir = await stateDir();
  await fs.writeFile(
    path.join(dir, "operation.json"),
    JSON.stringify({ ...record(), phase: "future-phase" }),
    "utf8",
  );
  const read = await loadOperation(dir);
  assert.equal(read.kind, "unreadable");
});
