/**
 * M6 provenance acceptance checks (test-plan M6 rows: provenance journal
 * forward-only; genesis machines are NOT_OBSERVED and never counted as
 * "recorded"; an unreadable/corrupt journal is a THIRD state, never
 * genesis; every reconcile that reaches the transaction records WHO drove
 * it, write-ahead).
 *
 * These drive createUpgrader in-process (the library plane — the journal
 * is exactly the kind of internal tooth the black-box plane cannot reach).
 * Mutation journals/summaries live in m6Mutations.ts (line budget).
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { type ToothContext } from "../teeth/registry.ts";
import { createUpgrader, type CreateUpgraderOptions } from "../../../core/src/createUpgrader.ts";
import type { ReleaseSource } from "../../../core/src/artifact/source.ts";
import { staticManifestSource } from "../../../core/src/artifact/staticManifestSource.ts";
import {
  fileProvenanceJournal,
  summarizeProvenance,
  type ProvenanceJournal,
  type ProvenanceEntry,
} from "../../../core/src/provenance/journal.ts";
import { systemClock } from "../../../core/src/clock.ts";
import type { HostAdapter, ProcessEvidence, Slot } from "../../../core/src/lifecycle/hostAdapter.ts";
import { serveRelease } from "./m1.ts";
import type { FakeServer } from "../fake-server/server.ts";
import {
  reuseSeqJournal,
  acceptingJournal,
  keepTornJournal,
  appendOnCorruptJournal,
  emptyAsGenesisJournal,
  mergeUnreadableSummary,
  promoteOnlyJournal,
} from "./m6Mutations.ts";

export function stateDir(ctx: ToothContext): string {
  return path.join(ctx.sandboxDir, "state");
}

function provenanceFile(ctx: ToothContext): string {
  return path.join(stateDir(ctx), "provenance", "provenance.jsonl");
}

/** A host whose probe reports the experiment's (configured) version. */
export function hostReporting(experimentVersion: string): HostAdapter {
  let version = "1.0.0";
  let startId = "init";
  return {
    async quiesce() {},
    async stop() {},
    async start(slot: Slot) {
      version = slot === "experiment" ? experimentVersion : "1.0.0";
      startId = `${slot}-${Math.random().toString(36).slice(2)}`;
    },
    async healthProbe(): Promise<ProcessEvidence> {
      return { version, pid: process.pid, startId };
    },
    async resume() {},
  };
}

export interface MakeUpgraderOpts {
  policy?: "auto" | "confirm" | "notify-only";
  installOwnership?: () => "self" | "managed-elsewhere";
  notificationSink?: (event: { kind: string; detail: Record<string, string> }) => Promise<void>;
  host?: HostAdapter;
  source?: ReleaseSource;
}

export async function makeUpgrader(
  ctx: ToothContext,
  server: FakeServer,
  journal: ProvenanceJournal | null,
  opts: MakeUpgraderOpts = {},
): Promise<ReturnType<typeof createUpgrader>> {
  const base: Omit<CreateUpgraderOptions, "provenance"> = {
    host: opts.host ?? hostReporting("2.0.0"),
    source: opts.source ?? staticManifestSource({ baseUrl: server.url }),
    policy: opts.policy ?? "auto",
    notificationSink: (opts.notificationSink ?? (async () => {})) as CreateUpgraderOptions["notificationSink"],
    stateDir: stateDir(ctx),
    ...(opts.installOwnership === undefined ? {} : { installOwnership: opts.installOwnership }),
  };
  return createUpgrader(journal === null ? base : { ...base, provenance: journal });
}

// ---------------------------------------------------------------------------
// m6.provenance-forward-only
// ---------------------------------------------------------------------------

export async function checkM6ProvenanceForwardOnly(
  ctx: ToothContext,
  opts: { acceptRewrite?: boolean; keepTorn?: boolean; reuseSeqs?: boolean; appendOnCorrupt?: boolean } = {},
): Promise<void> {
  const real = fileProvenanceJournal(path.join(stateDir(ctx), "provenance"), systemClock);
  const journal = opts.acceptRewrite
    ? acceptingJournal()
    : opts.keepTorn
      ? keepTornJournal(real, provenanceFile(ctx))
      : opts.reuseSeqs
        ? reuseSeqJournal()
        : opts.appendOnCorrupt
          ? appendOnCorruptJournal(provenanceFile(ctx), real)
          : real;

  const e1 = await journal.append({ who: "srv", carrier: "fleet", version: "2.0.0" });
  const e2 = await journal.append({ who: "srv", carrier: "fleet", version: "2.0.0" });
  assert.equal(e1.seq, 0, "first append is seq 0");
  assert.equal(
    e2.seq,
    1,
    "second append is seq 1 — appends are append-only, history cannot be collapsed (reuseSeqs => RED)",
  );

  // An overwrite of an existing entry is REFUSED (provenance is not
  // rewritable — a rewrite would let a later actor re-write who did what).
  await assert.rejects(
    journal.append({ who: "srv", carrier: "fleet", version: "2.0.0" }, 0),
    /PROVENANCE_SEQ_REWRITE/,
    "an overwrite of an existing entry must be refused (acceptRewrite => RED)",
  );

  // A torn final line (crash mid-append) is dropped; earlier lines stand.
  await fs.appendFile(provenanceFile(ctx), '{"seq":2,"who":', "utf8");
  const read = await journal.read();
  assert.equal(read.kind, "observed");
  assert.deepEqual(
    read.entries.map((e) => e.seq),
    [0, 1],
    "appends are forward-only: unique, in order, and a torn final line is dropped (keepTorn => RED)",
  );

  // A corrupt MIDDLE line makes the history unreadable — and appending to
  // it is REFUSED (a truncated view must never re-issue a seq).
  await fs.writeFile(
    provenanceFile(ctx),
    '{"seq":0,"who":"a","carrier":"c","when":1,"version":"2.0.0"}\n{"seq":1,"BROKEN\n{"seq":2,"who":"b","carrier":"c","when":2,"version":"2.0.0"}\n',
    "utf8",
  );
  const afterCorrupt = await journal.read();
  assert.equal(
    afterCorrupt.kind,
    "unreadable",
    "a corrupt middle line makes the history unreadable, never a short observed one (appendOnCorrupt => RED)",
  );
  await assert.rejects(
    journal.append({ who: "srv", carrier: "fleet", version: "2.0.0" }),
    /PROVENANCE_HISTORY_UNREADABLE/,
    "appending on an unreadable history must be refused — a guessed seq is how history becomes rewritable (appendOnCorrupt => RED)",
  );
}

// ---------------------------------------------------------------------------
// m6.provenance-genesis-not-observed
// ---------------------------------------------------------------------------

export async function checkM6ProvenanceGenesisNotObserved(
  ctx: ToothContext,
  opts: {
    collapseGenesis?: boolean;
    emptyIsGenesis?: boolean;
    unreadableIsGenesis?: boolean;
    mergeUnreadableIntoNotObserved?: boolean;
  } = {},
): Promise<void> {
  const provDir = path.join(stateDir(ctx), "provenance");
  const journal = fileProvenanceJournal(provDir, systemClock);

  // A machine with NO journal file never had the machinery: GENESIS. Its
  // value is NOT_OBSERVED, not "zero reconciles".
  const genesis = opts.collapseGenesis ? { kind: "observed" as const, entries: [] as ProvenanceEntry[] } : await journal.read();
  assert.equal(
    genesis.kind,
    "genesis",
    "a machine with no journal is genesis — NOT_OBSERVED, never an observed zero (collapseGenesis => RED)",
  );

  // An empty-but-present journal IS an observed machine: the machinery
  // exists and has reconciled zero times. Distinct from genesis.
  await fs.mkdir(provDir, { recursive: true });
  await fs.writeFile(path.join(provDir, "provenance.jsonl"), "", "utf8");
  const empty = opts.emptyIsGenesis ? await emptyAsGenesisJournal().read() : await journal.read();
  assert.equal(
    empty.kind,
    "observed",
    "an empty-but-present journal is observed-with-zero reconciles, distinct from genesis (emptyIsGenesis => RED)",
  );

  // A journal that exists but cannot be read (here: the file became a
  // directory, EISDIR) is the THIRD state — NOT genesis, NOT observed.
  await fs.rm(path.join(provDir, "provenance.jsonl"), { force: true });
  await fs.mkdir(path.join(provDir, "provenance.jsonl"));
  const unreadable = opts.unreadableIsGenesis ? { kind: "genesis" as const } : await journal.read();
  assert.equal(
    unreadable.kind,
    "unreadable",
    "an unreadable journal is its own state, never genesis — \"I cannot see the data\" is not \"there is no data\" (unreadableIsGenesis => RED)",
  );

  // Aggregation keeps the buckets separate: genesis → notObserved, never
  // recorded; unreadable → unreadable, never recorded AND never notObserved.
  const sum = opts.mergeUnreadableIntoNotObserved
    ? mergeUnreadableSummary([genesis, empty, unreadable])
    : summarizeProvenance([genesis, empty, unreadable]);
  assert.equal(sum.notObserved, 1, "the genesis machine is counted in notObserved, never in recorded");
  assert.equal(sum.recorded, 1, "only the observed machine is counted as recorded");
  assert.equal(
    sum.unreadable,
    1,
    "the unreadable machine is counted in unreadable — a separate bucket (mergeUnreadableIntoNotObserved => RED)",
  );
  assert.equal(sum.reconciles, 0, "zero reconciles stays zero");
}

// ---------------------------------------------------------------------------
// m6.provenance-records-each-reconcile
// ---------------------------------------------------------------------------

export async function checkM6ProvenanceRecordsEachReconcile(
  ctx: ToothContext,
  opts: { journalOnPromoteOnly?: boolean; skipJournaling?: boolean } = {},
): Promise<void> {
  const real = fileProvenanceJournal(path.join(stateDir(ctx), "provenance"), systemClock);
  const deferred = promoteOnlyJournal(real);
  const journal = opts.journalOnPromoteOnly ? deferred : real;

  const good = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "good" });
  const bad = await serveRelease(ctx, { version: "3.0.0", behavior: "ok", name: "bad" });
  try {
    // Reconcile 1 (good source): promotes.
    const goodUpgrader = await makeUpgrader(ctx, good, opts.skipJournaling ? null : journal);
    const r1 = await goodUpgrader.upgradeTo("2.0.0", {
      consented: true,
      provenance: { who: "fleet-control", carrier: "example-host" },
    });
    assert.equal(r1.result, "promoted", "the good reconcile must promote");
    if (opts.journalOnPromoteOnly) await deferred.flush();

    // Reconcile 2 (source moved on): a version the host's probe cannot
    // vouch for — reaches the transaction, then auto-rolls back. Its entry
    // must STILL be recorded (the append happened write-ahead, before the
    // outcome existed).
    const badUpgrader = await makeUpgrader(ctx, bad, opts.skipJournaling ? null : journal);
    const r2 = await badUpgrader.upgradeTo("3.0.0", {
      consented: true,
      provenance: { who: "fleet-control", carrier: "example-host" },
    });
    assert.equal(r2.result, "rolled-back", "the bad reconcile must roll back");
    if (opts.journalOnPromoteOnly) {
      // mutation: journaling happened only after promote — the failed
      // reconcile's entry was dropped, so the count assertion goes RED
    }

    const read = await journal.read();
    assert.equal(read.kind, "observed");
    assert.equal(
      read.entries.length,
      2,
      "every reconcile that reaches the transaction is recorded, including the one that rolled back (journalOnPromoteOnly | skipJournaling => RED)",
    );
    assert.equal(read.entries[0]!.version, "2.0.0", "the recorded version is the one the good reconcile drove");
    assert.equal(read.entries[1]!.version, "3.0.0", "the recorded version is the one the failed reconcile drove");
    for (const e of read.entries) {
      assert.equal(e.who, "fleet-control", "the recorded who is the driving identity");
      assert.equal(e.carrier, "example-host", "the recorded carrier is the command channel");
    }
  } finally {
    await good.stop();
    await bad.stop();
  }
}
