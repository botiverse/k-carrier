// @invariant — the canonical upgrade drive must spend the release source's
// exact artifact size on distinct response, idle, and overall byte budgets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpgradeEngine } from "../txn/engine.ts";
import type { OperationLifecycle } from "../operationLifecycle.ts";
import type { DownloadOptions } from "../artifact/transferPolicy.ts";
import { systemClock } from "../clock.ts";
import { driveUpgrade } from "./drive.ts";

test("canonical drive derives all transfer budgets from the exact release size", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "k-transfer-drive-"));
  const captured: { value: DownloadOptions | null } = { value: null };
  const engine = {
    recover: async () => {},
    upgrade: async () => ({ result: "up-to-date" as const }),
  } as unknown as UpgradeEngine;
  const operation = {
    begin: async () => {},
    transition: async () => {},
    settleRecovery: async () => {},
    reset: () => {},
    read: async () => ({ kind: "genesis" as const }),
    acknowledge: async () => "not-found" as const,
  } satisfies OperationLifecycle;

  const result = await driveUpgrade({
    stateDir,
    clock: systemClock,
    engine,
    operation,
    ownership: () => "self",
    readStableVersion: async () => "1.0.0",
    policy: "auto",
    notificationSink: async () => {},
    lifecycleSurfaceCount: 0,
    evidence: () => null,
    lifecycle: () => null,
    persistConvergenceReport: async () => {},
    artifactTransferPolicy: {
      responseTimeoutMs: 2_000,
      idleTimeoutMs: 3_000,
      minimumBytesPerSecond: 1_000,
      maximumOverallTimeoutMs: 20_000,
    },
    downloadArtifact: async (_release, opts) => {
      captured.value = opts;
      return new Uint8Array([1]);
    },
  }, {
    pick: async () => ({
      version: "2.0.0",
      url: "https://artifacts.invalid/computer.bin",
      sha256: "a".repeat(64),
      size: 9_000,
    }),
  });

  assert.equal(result.result, "up-to-date");
  assert.ok(captured.value !== null);
  assert.equal(captured.value.responseTimeoutMs, 2_000);
  assert.equal(captured.value.idleTimeoutMs, 3_000);
  assert.equal(captured.value.timeoutMs, 11_000);
});
