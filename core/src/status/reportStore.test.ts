// @invariant — report store unit invariants: the last convergence report
// survives restarts (persist + load round-trip), a missing report reads
// null (never a fabricated pass), and a corrupt report reads null
// (fail-safe — the provenance journal is the durable record of whether
// reconciliation happened at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { persistReport, loadLastReport } from "./reportStore.ts";
import type { ConvergenceReport } from "../converge/predicates.ts";

const report: ConvergenceReport = {
  version: "2.0.0",
  binaryAtTarget: { passed: true, source: "host.healthProbe", observedAtMs: 1, detail: { version: "2.0.0" } },
  hostLifecycleConverged: { passed: true, source: "test.autostart", observedAtMs: 1, detail: {} },
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "k-report-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("persist + load round-trips the report (a restart must not erase it)", async () => {
  await withDir(async (dir) => {
    await persistReport(dir, report);
    const loaded = await loadLastReport(dir);
    assert.deepEqual(loaded, report);
  });
});

test("a machine that never promoted reads null — never a fabricated pass", async () => {
  await withDir(async (dir) => {
    assert.equal(await loadLastReport(dir), null);
  });
});

test("a corrupt report reads null (fail-safe; the journal is the truth)", async () => {
  await withDir(async (dir) => {
    await persistReport(dir, report);
    await fs.writeFile(path.join(dir, "report.json"), '{"version": "2.0.0", "binaryAtTarget": BROKEN', "utf8");
    assert.equal(await loadLastReport(dir), null);
  });
});

test("a report missing its version stamp reads null (consumers cannot join)", async () => {
  await withDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "report.json"),
      JSON.stringify({ binaryAtTarget: report.binaryAtTarget, hostLifecycleConverged: null }),
      "utf8",
    );
    assert.equal(await loadLastReport(dir), null);
  });
});

test("persist is atomic (tmp + rename): a crash mid-write leaves the old report", async () => {
  await withDir(async (dir) => {
    await persistReport(dir, report);
    // simulate a torn tmp from a crashed persist: the target must be intact
    await fs.writeFile(path.join(dir, "report.json.tmp"), '{"version":', "utf8");
    const loaded = await loadLastReport(dir);
    assert.deepEqual(loaded, report, "the committed report survives a torn tmp");
  });
});
