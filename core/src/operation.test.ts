// @invariant — K's operation receipt is the only durable transaction status
// a host may project, so corrupt/future/active records must fail closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  archiveOperation,
  loadArchivedOperation,
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
  };
}

test("archive preserves the complete terminal result", async () => {
  const dir = await stateDir();
  const original = record();
  await persistOperation(dir, original);
  await archiveOperation(dir, original);
  await archiveOperation(dir, original);
  assert.deepEqual(await loadArchivedOperation(dir, "op-1"), { kind: "observed", operation: original });
  assert.deepEqual(await loadOperation(dir), { kind: "observed", operation: original });
  assert.deepEqual(await loadArchivedOperation(dir, "other"), { kind: "genesis" });
});

test("an active operation cannot be archived as if it were terminal", async () => {
  const dir = await stateDir();
  await assert.rejects(archiveOperation(dir, { ...record(), phase: "handing-over", outcome: null }), /active/);
  assert.deepEqual(await loadArchivedOperation(dir, "op-1"), { kind: "genesis" });
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
