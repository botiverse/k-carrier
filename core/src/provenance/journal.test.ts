// @invariant — provenance journal unit invariants: append-only history,
// three-state read (genesis / observed / unreadable), middle-line
// corruption never truncates, aggregation keeps the buckets separate. The
// harness teeth drive the same module through the real upgrader path; this
// file pins the journal's own contract directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  fileProvenanceJournal,
  summarizeProvenance,
  ProvenanceError,
  type ProvenanceRead,
} from "./journal.ts";
import type { Clock } from "../clock.ts";

const fakeClock: Clock = {
  nowMs: () => 1_700_000_000_000,
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "k-provenance-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("appends are sequential and read back in file order", async () => {
  await withDir(async (dir) => {
    const j = fileProvenanceJournal(dir, fakeClock);
    const e1 = await j.append({ who: "a", carrier: "c", version: "2.0.0" });
    const e2 = await j.append({ who: "b", carrier: "c", version: "2.0.0" });
    assert.equal(e1.seq, 0);
    assert.equal(e2.seq, 1);
    const read = await j.read();
    assert.equal(read.kind, "observed");
    if (read.kind !== "observed") return;
    assert.deepEqual(
      read.entries.map((e) => [e.seq, e.who]),
      [
        [0, "a"],
        [1, "b"],
      ],
    );
    assert.equal(read.entries[0]!.when, 1_700_000_000_000, "when comes from the clock, not Date.now");
  });
});

test("the public file journal has a real-clock default", async () => {
  await withDir(async (dir) => {
    const journal = fileProvenanceJournal(dir);
    const entry = await journal.append({ who: "local", carrier: "cli", version: "1.0.0" });
    assert.equal(Number.isFinite(entry.when), true);
    assert.ok(entry.when > 0);
  });
});

test("an explicit seq at or below the last one is refused", async () => {
  await withDir(async (dir) => {
    const j = fileProvenanceJournal(dir, fakeClock);
    await j.append({ who: "a", carrier: "c", version: "2.0.0" });
    await assert.rejects(
      j.append({ who: "a", carrier: "c", version: "2.0.0" }, 0),
      (err: unknown) => err instanceof ProvenanceError && err.code === "PROVENANCE_SEQ_REWRITE",
    );
  });
});

test("a torn final line is dropped; earlier lines stand", async () => {
  await withDir(async (dir) => {
    const j = fileProvenanceJournal(dir, fakeClock);
    await j.append({ who: "a", carrier: "c", version: "2.0.0" });
    await j.append({ who: "b", carrier: "c", version: "2.0.0" });
    await fs.appendFile(path.join(dir, "provenance.jsonl"), '{"seq":2,"who":', "utf8");
    const read = await j.read();
    assert.equal(read.kind, "observed");
    if (read.kind === "observed") {
      assert.deepEqual(
        read.entries.map((e) => e.seq),
        [0, 1],
      );
    }
  });
});

test("a corrupt MIDDLE line makes the history unreadable — never a short observed", async () => {
  await withDir(async (dir) => {
    const j = fileProvenanceJournal(dir, fakeClock);
    await j.append({ who: "a", carrier: "c", version: "2.0.0" });
    await j.append({ who: "b", carrier: "c", version: "2.0.0" });
    await fs.appendFile(path.join(dir, "provenance.jsonl"), '{"seq":1,"BROKEN\n{"seq":2,"who":"b","carrier":"c","when":2,"version":"2.0.0"}\n', "utf8");
    const read = await j.read();
    assert.equal(read.kind, "unreadable", "middle-line corruption is unreadable, not observed");
  });
});

test("appending on an unreadable history is refused (no guessed seq)", async () => {
  await withDir(async (dir) => {
    const j = fileProvenanceJournal(dir, fakeClock);
    await j.append({ who: "a", carrier: "c", version: "2.0.0" });
    await j.append({ who: "b", carrier: "c", version: "2.0.0" });
    // corrupt the MIDDLE line, with a good tail after it
    await fs.appendFile(path.join(dir, "provenance.jsonl"), '{"seq":1,"BROKEN\n{"seq":2,"who":"b","carrier":"c","when":2,"version":"2.0.0"}\n', "utf8");
    await assert.rejects(
      j.append({ who: "c", carrier: "c", version: "2.0.0" }),
      (err: unknown) => err instanceof ProvenanceError && err.code === "PROVENANCE_HISTORY_UNREADABLE",
    );
  });
});

test("no journal file is genesis; an empty file is observed-with-zero; EISDIR is unreadable", async () => {
  await withDir(async (dir) => {
    const j = fileProvenanceJournal(dir, fakeClock);
    const genesis = await j.read();
    assert.equal(genesis.kind, "genesis");

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "provenance.jsonl"), "", "utf8");
    const empty = await j.read();
    assert.equal(empty.kind, "observed");
    if (empty.kind === "observed") assert.equal(empty.entries.length, 0);

    // the journal path became a directory: exists, cannot be read
    await fs.rm(path.join(dir, "provenance.jsonl"), { force: true });
    await fs.mkdir(path.join(dir, "provenance.jsonl"));
    const unreadable = await j.read();
    assert.equal(unreadable.kind, "unreadable", "an unreadable journal is its own state");
    if (unreadable.kind === "unreadable") assert.ok(unreadable.reason.length > 0);
  });
});

test("aggregation keeps genesis, observed and unreadable in separate buckets", async () => {
  const reads: ProvenanceRead[] = [
    { kind: "genesis" },
    { kind: "genesis" },
    { kind: "observed", entries: [{ seq: 0, who: "a", carrier: "c", when: 1, version: "2.0.0" }] },
    { kind: "observed", entries: [] },
    { kind: "unreadable", reason: "EACCES" },
  ];
  const s = summarizeProvenance(reads);
  assert.equal(s.recorded, 2, "only observed machines count as recorded");
  assert.equal(s.reconciles, 1, "only real entries count as reconciles");
  assert.equal(s.notObserved, 2, "genesis machines are NOT_OBSERVED, never folded in");
  assert.equal(s.unreadable, 1, "unreadable is a third bucket, never recorded and never notObserved");
});
