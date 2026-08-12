/**
 * M6 status-report acceptance checks (test-plan M6 rows: the fleet
 * read-back equals the live sources at the same moment; a machine that has
 * never observed a promote reports NOT_OBSERVED — never a fabricated pass;
 * an unreadable report is its own state, never "never observed"; an
 * observed pass survives a restart).
 *
 * These drive createUpgrader in-process: status() is the L5 read-back
 * surface, and the teeth pin that it is a READ-BACK, not an invention.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { type ToothContext } from "../teeth/registry.ts";
import { fileProvenanceJournal } from "../../../core/src/provenance/journal.ts";
import { systemClock } from "../../../core/src/clock.ts";
import type { StatusReport, StatusPredicates } from "../../../core/src/status/report.ts";
import { serveRelease } from "./m1.ts";
import { stateDir, makeUpgrader } from "./m6.ts";

function reportFile(ctx: ToothContext): string {
  return path.join(stateDir(ctx), "report.json");
}

// ---------------------------------------------------------------------------
// m6.status-report-matches-local
// ---------------------------------------------------------------------------

/** Mutation: a status report that INVENTED a field (stable says 9.9.9 while
 * the machine is on 1.0.0) — the read-back violation the tooth guards
 * against. */
function inventedStatus(base: StatusReport): StatusReport {
  return { ...base, stable: "9.9.9" };
}

/** Mutation: a REAL conclusion pasted onto the WRONG version (the predicates
 * are 2.0.0's but claim 3.0.0) — worse than a fake, because consumers join
 * on the stamp. */
function wrongStamp(base: StatusReport): StatusReport {
  if (base.predicates.kind !== "observed") return base;
  return { ...base, predicates: { ...base.predicates, version: "3.0.0" } };
}

export async function checkM6StatusReportMatchesLocal(
  ctx: ToothContext,
  opts: { inventStable?: boolean; wrongVersionStamp?: boolean } = {},
): Promise<void> {
  const journal = fileProvenanceJournal(path.join(stateDir(ctx), "provenance"), systemClock);
  const server = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "target" });
  try {
    const upgrader = await makeUpgrader(ctx, server, journal);

    // Fresh machine: the report equals the live sources AT THE SAME MOMENT.
    const st1 = await upgrader.state();
    const s1 = opts.inventStable ? inventedStatus(await upgrader.status()) : await upgrader.status();
    assert.equal(
      s1.stable,
      st1.stableVersion,
      "the report's stable is the machine's stable, never an invention (inventStable => RED)",
    );
    assert.equal(s1.experiment, st1.experimentVersion, "the report's experiment is the machine's experiment");
    assert.equal(s1.phase, st1.phase, "the report's phase is the machine's phase");
    assert.equal(s1.policy, "auto", "the report's policy is the configured policy");
    const jr = await journal.read();
    assert.deepEqual(s1.provenance, jr, "the report's provenance is the journal's read");

    // After a real promote: the predicates are the last REAL report's,
    // stamped with the version they evaluated.
    const outcome = await upgrader.upgradeTo("2.0.0", {
      consented: true,
      provenance: { who: "fleet-control", carrier: "example-host" },
    });
    assert.equal(outcome.result, "promoted", "the reconcile must promote");
    assert.ok(outcome.report !== null, "a promoted reconcile carries a convergence report");
    assert.equal(outcome.report!.version, "2.0.0", "the convergence report is stamped with the version it evaluated");
    const s2 = opts.wrongVersionStamp ? wrongStamp(await upgrader.status()) : await upgrader.status();
    assert.equal(
      s2.predicates.kind,
      "observed",
      "after a promote the predicates are the real report's (wrongVersionStamp => RED)",
    );
    if (s2.predicates.kind !== "observed") return;
    assert.equal(
      s2.predicates.version,
      "2.0.0",
      "the status passes the evaluated version through verbatim — a real conclusion must never be joined to the wrong version (wrongVersionStamp => RED)",
    );
    assert.deepEqual(
      s2.predicates.binaryAtTarget,
      outcome.report!.binaryAtTarget,
      "the report's binaryAtTarget is the last real evaluation",
    );
    assert.deepEqual(
      s2.predicates.hostLifecycleConverged,
      outcome.report!.hostLifecycleConverged,
      "the report's lifecycle predicate is the last real evaluation",
    );
    const st2 = await upgrader.state();
    assert.equal(s2.stable, st2.stableVersion, "after promote, the report still reads the live stable");
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// m6.status-report-silence-not-evidence
// ---------------------------------------------------------------------------

/** Mutation: a PASSING predicate a machine never evaluated (silence spent
 * as evidence) — the wrong status reports an `observed` shape on a machine
 * whose predicates are actually genesis. */
function fabricatedPass(which: "binary" | "lifecycle"): StatusPredicates {
  const fake = { passed: true, source: "fabricated", observedAtMs: 0, detail: {} };
  return which === "binary"
    ? { kind: "observed", version: "2.0.0", binaryAtTarget: fake, hostLifecycleConverged: null }
    : { kind: "observed", version: "2.0.0", binaryAtTarget: { ...fake, detail: { version: "2.0.0" } }, hostLifecycleConverged: fake };
}

/** Mutation: the report lives only in memory — a restart erases the
 * observation ("observed, I restarted" collapses into "never observed"). */
function forgettingStatus(base: StatusReport): StatusReport {
  return { ...base, predicates: { kind: "genesis" } };
}

export async function checkM6StatusReportSilenceNotEvidence(
  ctx: ToothContext,
  opts: {
    fabricateBinaryPassed?: boolean;
    fabricateConvergedPassed?: boolean;
    fabricateAfterRollback?: boolean;
    noPersistence?: boolean;
    unreadableIsGenesis?: boolean;
  } = {},
): Promise<void> {
  const journal = fileProvenanceJournal(path.join(stateDir(ctx), "provenance"), systemClock);
  const good = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "good" });
  const bad = await serveRelease(ctx, { version: "3.0.0", behavior: "ok", name: "bad" });
  try {
    const upgrader = await makeUpgrader(ctx, good, journal);

    // A machine that never observed a promote is NOT_OBSERVED — never a
    // fabricated pass (in either predicate).
    const fresh = await upgrader.status();
    const s1 = opts.fabricateBinaryPassed
      ? { ...fresh, predicates: fabricatedPass("binary") }
      : opts.fabricateConvergedPassed
        ? { ...fresh, predicates: fabricatedPass("lifecycle") }
        : fresh;
    assert.equal(
      s1.predicates.kind,
      "genesis",
      "never observed => predicates are genesis (NOT_OBSERVED), never a fabricated pass (fabricateBinaryPassed | fabricateConvergedPassed => RED)",
    );

    // A reconcile that REACHES the machine but FAILS (auto-rollback) does
    // not become a pass either: the machine observed a failure, and
    // "observed a failure" is not "evaluated and passed". A second upgrader
    // on the moved-on source (same machine: stateDir + journal shared) does
    // the failing attempt; it has never promoted, so its predicates must
    // still be genesis.
    const failingUpgrader = await makeUpgrader(ctx, bad, journal);
    const r = await failingUpgrader.upgradeTo("3.0.0", {
      consented: true,
      provenance: { who: "fleet-control", carrier: "example-host" },
    });
    assert.equal(r.result, "rolled-back", "the bad reconcile must roll back");
    const after = await failingUpgrader.status();
    const s2 = opts.fabricateAfterRollback ? { ...after, predicates: fabricatedPass("lifecycle") } : after;
    assert.equal(
      s2.predicates.kind,
      "genesis",
      "a rolled-back reconcile observes a failure, never a pass (fabricateAfterRollback => RED)",
    );

    // A machine that DID converge must not report NOT_OBSERVED after a
    // restart: "observed, I restarted" is not "never observed". The report
    // is persisted at promote and loaded by a fresh upgrader on the same
    // stateDir.
    const promoted = await upgrader.upgradeTo("2.0.0", {
      consented: true,
      provenance: { who: "fleet-control", carrier: "example-host" },
    });
    assert.equal(promoted.result, "promoted", "the good reconcile must promote");
    const restarted = await makeUpgrader(ctx, good, journal); // same stateDir: the daemon restarted
    const afterRestart = opts.noPersistence
      ? forgettingStatus(await restarted.status())
      : await restarted.status();
    assert.equal(
      afterRestart.predicates.kind,
      "observed",
      "an observed pass survives a restart — the persisted report is loaded, never erased (noPersistence => RED)",
    );
    if (afterRestart.predicates.kind !== "observed") return;
    assert.equal(afterRestart.predicates.version, "2.0.0", "the persisted report keeps its version stamp");
    assert.equal(
      afterRestart.predicates.binaryAtTarget.passed,
      true,
      "the persisted report carries the real observed result, not a fabrication",
    );

    // A report that exists but cannot be read is the THIRD state — never
    // genesis ("I cannot see the data" is not "there is no data"), and
    // retirement names the true reason instead of the fake "never observed".
    await fs.writeFile(reportFile(ctx), '{"version": "2.0.0", "binaryAtTarget": BROKEN', "utf8");
    const afterCorrupt = await makeUpgrader(ctx, good, journal);
    const s4 = opts.unreadableIsGenesis
      ? { ...(await afterCorrupt.status()), predicates: { kind: "genesis" as const } }
      : await afterCorrupt.status();
    assert.equal(
      s4.predicates.kind,
      "unreadable",
      "an unreadable report is its own state, never genesis (unreadableIsGenesis => RED)",
    );
    const retire = await afterCorrupt.retireLegacyManager();
    assert.notEqual(retire, "retired", "retirement stays fail-closed on an unreadable report");
    assert.ok(
      typeof retire === "object" && retire.held.includes("cannot be read"),
      "the retirement HOLD names the real reason: unreadable, not never-observed",
    );
  } finally {
    await good.stop();
    await bad.stop();
  }
}
