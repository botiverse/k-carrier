// @invariant — failing seeds are durably and deterministically merged into a
// replay corpus; a second write cannot duplicate an existing failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSimulation } from "./run.ts";
import { recordFailures } from "./record.ts";

test("failure corpus records and deduplicates an exact replay seed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k-sim-record-"));
  try {
    const file = path.join(dir, "failures.json");
    const failure = await runSimulation(7, {
      mutation: "drop-journal-durability",
      faults: false,
    });
    assert.equal(failure.status, "fail");
    assert.equal(await recordFailures(file, [failure]), 1);
    const firstBytes = await fs.readFile(file, "utf8");

    assert.equal(await recordFailures(file, [failure]), 1);
    assert.equal(await fs.readFile(file, "utf8"), firstBytes, "same failure set must produce same bytes");

    const parsed = JSON.parse(firstBytes) as {
      formatVersion: number;
      failures: Array<{ seed: number; replay: string; transcriptSha256: string }>;
    };
    assert.equal(parsed.formatVersion, 1);
    assert.equal(parsed.failures.length, 1);
    assert.equal(parsed.failures[0]!.seed, 7);
    assert.equal(parsed.failures[0]!.replay, "k-harness sim --seed 7 --json");
    assert.equal(parsed.failures[0]!.transcriptSha256, failure.transcriptSha256);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a green batch creates no failure-corpus side effect", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k-sim-record-green-"));
  try {
    const file = path.join(dir, "failures.json");
    const pass = await runSimulation(17, { faults: false });
    assert.equal(pass.status, "pass");
    assert.equal(await recordFailures(file, [pass]), 0);
    await assert.rejects(fs.stat(file), (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
