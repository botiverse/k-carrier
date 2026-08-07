// @invariant — M1 download-hole teeth self-verification: known-green on a
// clean world, known-red under each declared mutation (archer's 8 fixes
// turned into red-able acceptance surfaces; one negative control per
// conjunct).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkDownloadTimeoutEnforced,
  checkPlatformKeyNativeArch,
  checkDownloadProgressWithoutResumeDir,
  checkDownloadEmptyBodyNamed,
  checkDownloadStallBoundsSilence,
  checkDownloadErrorsClassified,
  checkDownloadStallPhaseHonest,
} from "../artifact/downloadHoles.ts";

const TOOTH_IDS = new Set([
  "m1.download-timeout-enforced",
  "m1.platform-key-native-arch",
  "m1.download-progress-without-resumedir",
  "m1.download-empty-body-named",
  "m1.download-stall-bounds-silence",
  "m1.download-errors-classified",
  "m1.download-stall-phase-honest",
]);

const ctxFor = async (prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> => {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
};

test("known-green: every download-hole tooth passes on a clean world", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 7, "all seven download-hole teeth must be registered");
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

test("known-red: timeout-enforced catches a signal-only deadline", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-timeout");
  try {
    await assert.rejects(checkDownloadTimeoutEnforced(ctx, { signalOnly: true }), /must be enforced/);
  } finally {
    await teardown();
  }
});

test("known-red: platform-key catches a naive key (Rosetta pinned to x64)", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-naive-key");
  try {
    await assert.rejects(checkPlatformKeyNativeArch(ctx, { naiveKey: true }), /naiveKey => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: platform-key catches a probe consulted everywhere", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-probe");
  try {
    await assert.rejects(checkPlatformKeyNativeArch(ctx, { probeEverywhere: true }), /probeEverywhere => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: progress-without-resumedir catches an arrayBuffer path", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-progress");
  try {
    await assert.rejects(checkDownloadProgressWithoutResumeDir(ctx, { noProgress: true }), /noProgress => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: empty-body-named catches zero bytes instead of the cause", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-empty");
  try {
    await assert.rejects(checkDownloadEmptyBodyNamed(ctx, { returnEmptyBytes: true }), /returnEmptyBytes => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: empty-body-named catches the resume path treating no body as an empty prefix", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-empty-prefix");
  try {
    await assert.rejects(checkDownloadEmptyBodyNamed(ctx, { treatEmptyAsPrefix: true }), /treatEmptyAsPrefix => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: stall-bounds catches a total-timeout stall budget", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-total");
  try {
    await assert.rejects(checkDownloadStallBoundsSilence(ctx, { totalTimeout: true }), /totalTimeout => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: stall-bounds catches a missing stall budget", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-nostall");
  try {
    await assert.rejects(checkDownloadStallBoundsSilence(ctx, { noStall: true }), /noStall => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: errors-classified catches a bare stream error", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-classify");
  try {
    await assert.rejects(checkDownloadErrorsClassified(ctx, { unclassified: true }), /unclassified => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: stall-phase catches a mid-body stall reported as awaiting-response", async () => {
  const { ctx, teardown } = await ctxFor("red-dl-phase");
  try {
    await assert.rejects(checkDownloadStallPhaseHonest(ctx, { wrongPhase: true }), /wrongPhase => RED/);
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
  assert.equal(byId.get("m1.download-timeout-enforced")!.run, checkDownloadTimeoutEnforced);
  assert.equal(byId.get("m1.platform-key-native-arch")!.run, checkPlatformKeyNativeArch);
  assert.equal(byId.get("m1.download-progress-without-resumedir")!.run, checkDownloadProgressWithoutResumeDir);
  assert.equal(byId.get("m1.download-empty-body-named")!.run, checkDownloadEmptyBodyNamed);
  assert.equal(byId.get("m1.download-stall-bounds-silence")!.run, checkDownloadStallBoundsSilence);
  assert.equal(byId.get("m1.download-errors-classified")!.run, checkDownloadErrorsClassified);
  assert.equal(byId.get("m1.download-stall-phase-honest")!.run, checkDownloadStallPhaseHonest);
});
