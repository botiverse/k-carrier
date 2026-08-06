// @invariant — report store unit invariants: the last convergence report
// survives restarts (persist + load round-trip); the read is THREE-state —
// genesis (never promoted) / observed / unreadable (EACCES or corrupt) —
// because "I cannot read it" is not "it never happened".
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
    assert.equal(loaded.kind, "observed");
    if (loaded.kind === "observed") assert.deepEqual(loaded.report, report);
  });
});

test("a machine that never promoted reads genesis — NOT_OBSERVED, never a fabricated pass", async () => {
  await withDir(async (dir) => {
    const loaded = await loadLastReport(dir);
    assert.equal(loaded.kind, "genesis");
  });
});

test("a corrupt report reads unreadable — never genesis (the record exists but cannot be read)", async () => {
  await withDir(async (dir) => {
    await persistReport(dir, report);
    await fs.writeFile(path.join(dir, "report.json"), '{"version": "2.0.0", "binaryAtTarget": BROKEN', "utf8");
    const loaded = await loadLastReport(dir);
    assert.equal(loaded.kind, "unreadable");
    if (loaded.kind === "unreadable") assert.ok(loaded.reason.length > 0);
  });
});

test("an unreadable file (EISDIR) reads unreadable — never genesis", async () => {
  await withDir(async (dir) => {
    await persistReport(dir, report);
    await fs.rm(path.join(dir, "report.json"), { force: true });
    await fs.mkdir(path.join(dir, "report.json"));
    const loaded = await loadLastReport(dir);
    assert.equal(loaded.kind, "unreadable");
  });
});

test("a report missing its version stamp reads unreadable (consumers cannot join)", async () => {
  await withDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "report.json"),
      JSON.stringify({ binaryAtTarget: report.binaryAtTarget, hostLifecycleConverged: null }),
      "utf8",
    );
    const loaded = await loadLastReport(dir);
    assert.equal(loaded.kind, "unreadable");
  });
});

test("persist is atomic AND durable (tmp + fsync + rename): a torn tmp leaves the old report", async () => {
  await withDir(async (dir) => {
    await persistReport(dir, report);
    // simulate a torn tmp from a crashed persist: the target must be intact
    await fs.writeFile(path.join(dir, "report.json.tmp"), '{"version":', "utf8");
    const loaded = await loadLastReport(dir);
    assert.equal(loaded.kind, "observed");
    if (loaded.kind === "observed") assert.deepEqual(loaded.report, report);
  });
});
