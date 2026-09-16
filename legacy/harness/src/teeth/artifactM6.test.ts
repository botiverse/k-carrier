// @invariant — M6 provenance teeth self-verification: known-green on a
// clean world, known-red under each declared mutation (one negative
// control per conjunct — an AND gate needs as many negative
// controls as it has conjuncts).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkM6ProvenanceForwardOnly,
  checkM6ProvenanceGenesisNotObserved,
  checkM6ProvenanceRecordsEachReconcile,
} from "../artifact/m6.ts";
import {
  checkM6StatusReportMatchesLocal,
  checkM6StatusReportSilenceNotEvidence,
} from "../artifact/m6Status.ts";

const TOOTH_IDS = new Set([
  "m6.provenance-forward-only",
  "m6.provenance-genesis-not-observed",
  "m6.provenance-records-each-reconcile",
  "m6.status-report-matches-local",
  "m6.status-report-silence-not-evidence",
]);

const ctxFor = async (prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> => {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
};

test("known-green: every M6 tooth passes on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 5, "all five M6 teeth must be registered");
  for (const tooth of teeth) {
    const { ctx, teardown } = await ctxFor(tooth.id.replaceAll(".", "-"));
    try {
      await tooth.run(ctx);
    } catch (err) {
      assert.fail(`tooth ${tooth.id} went RED on a clean world: ${(err as Error).message}`);
    } finally {
      await teardown();
    }
  }
});

test("known-red: forward-only catches an accepted overwrite", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-fwd-rewrite");
  try {
    await assert.rejects(
      checkM6ProvenanceForwardOnly(ctx, { acceptRewrite: true }),
      /must be refused/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: forward-only catches a kept torn line", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-fwd-torn");
  try {
    await assert.rejects(
      checkM6ProvenanceForwardOnly(ctx, { keepTorn: true }),
      /torn final line is dropped/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: forward-only catches collapsed (reused) seqs", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-fwd-reuse");
  try {
    await assert.rejects(
      checkM6ProvenanceForwardOnly(ctx, { reuseSeqs: true }),
      /history cannot be collapsed/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: forward-only catches an append on a corrupt history", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-fwd-corrupt");
  try {
    await assert.rejects(
      checkM6ProvenanceForwardOnly(ctx, { appendOnCorrupt: true }),
      /must be refused|unreadable/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: genesis catches a missing journal read as observed", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-genesis");
  try {
    await assert.rejects(
      checkM6ProvenanceGenesisNotObserved(ctx, { collapseGenesis: true }),
      /NOT_OBSERVED/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: genesis catches an empty journal read as genesis", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-empty");
  try {
    await assert.rejects(
      checkM6ProvenanceGenesisNotObserved(ctx, { emptyIsGenesis: true }),
      /distinct from genesis/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: genesis catches an unreadable journal read as genesis", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-unreadable");
  try {
    await assert.rejects(
      checkM6ProvenanceGenesisNotObserved(ctx, { unreadableIsGenesis: true }),
      /never genesis/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: genesis catches aggregation folding unreadable into notObserved", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-merged");
  try {
    await assert.rejects(
      checkM6ProvenanceGenesisNotObserved(ctx, { mergeUnreadableIntoNotObserved: true }),
      /notObserved|separate bucket/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: records-each-reconcile catches journaling after the outcome", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-posthoc");
  try {
    await assert.rejects(
      checkM6ProvenanceRecordsEachReconcile(ctx, { journalOnPromoteOnly: true }),
      /every reconcile that reaches the transaction is recorded/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: status-report-matches-local catches a wrong version stamp", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-stamp");
  try {
    await assert.rejects(
      checkM6StatusReportMatchesLocal(ctx, { wrongVersionStamp: true }),
      /never be joined to the wrong version/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: silence-not-evidence catches an unreadable report read as genesis", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-unreadable-report");
  try {
    await assert.rejects(
      checkM6StatusReportSilenceNotEvidence(ctx, { unreadableIsGenesis: true }),
      /never genesis/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: silence-not-evidence catches a restart erasing a real observation", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-nopersist");
  try {
    await assert.rejects(
      checkM6StatusReportSilenceNotEvidence(ctx, { noPersistence: true }),
      /survives a restart/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: status-report-matches-local catches an invented stable", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-status-invent");
  try {
    await assert.rejects(
      checkM6StatusReportMatchesLocal(ctx, { inventStable: true }),
      /never an invention/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: silence-not-evidence catches a fabricated binary pass", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-silence-binary");
  try {
    await assert.rejects(
      checkM6StatusReportSilenceNotEvidence(ctx, { fabricateBinaryPassed: true }),
      /never a fabricated pass/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: silence-not-evidence catches a fabricated convergence pass", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-silence-lifecycle");
  try {
    await assert.rejects(
      checkM6StatusReportSilenceNotEvidence(ctx, { fabricateConvergedPassed: true }),
      /never a fabricated pass/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: silence-not-evidence catches a rollback reported as a pass", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-silence-rollback");
  try {
    await assert.rejects(
      checkM6StatusReportSilenceNotEvidence(ctx, { fabricateAfterRollback: true }),
      /never a pass/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: records-each-reconcile catches a reconcile with no journaling", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-nojournal");
  try {
    await assert.rejects(
      checkM6ProvenanceRecordsEachReconcile(ctx, { skipJournaling: true }),
      /must be recorded|NOT_OBSERVED|genesis/,
    );
  } finally {
    await teardown();
  }
});

test("registration discipline: profiles/layers/kind/mustRed all answered", () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  for (const tooth of teeth) {
    assert.ok(tooth.profiles.length > 0, `${tooth.id}: profiles`);
    assert.ok(tooth.layers.length > 0, `${tooth.id}: layers`);
    assert.equal(tooth.kind.kind, "invariant", `${tooth.id}: kind`);
    assert.ok(tooth.mustRed.length > 0, `${tooth.id}: must-red`);
    for (const mr of tooth.mustRed) {
      assert.ok(mr.mutate.trim(), `${tooth.id}: mutation text`);
      const answered = mr.caughtOnlyBy === "this" || (mr.caughtOnlyBy.alsoCaughtBy.trim() && mr.caughtOnlyBy.whyStillNeeded.trim());
      assert.ok(answered, `${tooth.id}: caughtOnlyBy answered`);
    }
  }
  const exported = new Map(exportForMutationRunner().map((e) => [e.id, e]));
  for (const id of TOOTH_IDS) assert.ok(exported.has(id), `${id} must be in the mutation-runner export`);
});

test("tooth run functions are the exported checks (single source of truth)", () => {
  const byId = new Map(allTeeth().map((t) => [t.id, t] as const));
  assert.equal(byId.get("m6.provenance-forward-only")!.run, checkM6ProvenanceForwardOnly);
  assert.equal(byId.get("m6.provenance-genesis-not-observed")!.run, checkM6ProvenanceGenesisNotObserved);
  assert.equal(byId.get("m6.provenance-records-each-reconcile")!.run, checkM6ProvenanceRecordsEachReconcile);
  assert.equal(byId.get("m6.status-report-matches-local")!.run, checkM6StatusReportMatchesLocal);
  assert.equal(byId.get("m6.status-report-silence-not-evidence")!.run, checkM6StatusReportSilenceNotEvidence);
});
