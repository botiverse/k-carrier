import assert from "node:assert/strict";
import { SMOKE_SEEDS } from "./corpus.ts";
import { replayBytes, runSimulation, runSimulationBatch } from "./run.ts";

export async function checkSeedReplayIdentical(): Promise<void> {
  const seed = 0xdecafbad;
  const first = await runSimulation(seed);
  const second = await runSimulation(seed);
  assert.equal(replayBytes(first), replayBytes(second), "the same seed must replay byte-for-byte");

  const other = await runSimulation(seed + 1);
  assert.notEqual(
    first.transcriptSha256,
    other.transcriptSha256,
    "different seeds must control a different observable schedule",
  );
}

export async function checkSmokeSeeds(): Promise<void> {
  const batch = await runSimulationBatch(SMOKE_SEEDS);
  const failures = batch.results
    .filter((result) => result.status === "fail")
    .map((result) => `seed ${result.seed}: ${result.failure} (${result.replay})`);
  assert.deepEqual(failures, [], failures.join("\n"));
}

export async function checkFaultSurfaceCovered(): Promise<void> {
  const batch = await runSimulationBatch(SMOKE_SEEDS);
  for (const decision of [
    "delay",
    "crash-before",
    "crash-after",
    "fail-before",
    "partial-write",
    "reorder-volatile",
  ] as const) {
    assert.ok(
      batch.coverage[decision] > 0,
      `fixed smoke corpus never exercised ${decision}; add a seed before claiming that surface`,
    );
  }
  assert.ok(
    batch.results.some((result) => result.restarts > 0),
    "fixed smoke corpus must exercise recovery, not only clean upgrades",
  );
}
