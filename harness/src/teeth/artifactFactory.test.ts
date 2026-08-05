// @invariant — artifact-factory teeth self-verification: known-green on a
// clean world, known-red under each declared must-red mutation.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import "./artifactFactory.ts"; // registers the teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import { checkDeterministicBuild, checkOkArtifactRuns } from "../artifact-factory/checks.ts";
import { ArtifactFactory } from "../artifact-factory/factory.ts";
import { DEMO_SOURCE } from "../artifact-factory/demo.ts";

const TOOTH_IDS = new Set([
  "artifact-factory.deterministic-build",
  "artifact-factory.ok-artifact-runs",
]);

async function ctxFor(prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
}

test("known-green: both artifact-factory teeth pass on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 2, "both factory teeth must be registered");
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

test("known-red: deterministic-build catches a build that varies between runs", async () => {
  const { ctx, teardown } = await ctxFor("red-determinism");
  try {
    // mutation: the second build differs (simulated by a differing source —
    // the same way a stamp-embedded timestamp would make two builds diverge)
    const varying = new ArtifactFactory({
      cacheDir: path.join(ctx.sandboxDir, "cache-b"),
      demoSource: `${DEMO_SOURCE}\n// mutation: build-specific byte\n`,
    });
    await assert.rejects(
      checkDeterministicBuild(ctx, varying),
      /byte-identical artifacts/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: ok-artifact-runs catches a crashing build and a lying build", async () => {
  const crashCtx = await ctxFor("red-crash");
  try {
    await assert.rejects(
      checkOkArtifactRuns(crashCtx.ctx, "crash-on-start"),
      /exit 0/,
      "a crash-on-start build must turn the tooth red",
    );
  } finally {
    await crashCtx.teardown();
  }
  const lieCtx = await ctxFor("red-lie");
  try {
    await assert.rejects(
      checkOkArtifactRuns(lieCtx.ctx, "wrong-version-probe"),
      /stamped version/,
      "a wrong-version-probe build must turn the tooth red",
    );
  } finally {
    await lieCtx.teardown();
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
      assert.ok(
        mr.caughtOnlyBy === "this" ||
          (mr.caughtOnlyBy.alsoCaughtBy.trim() && mr.caughtOnlyBy.whyStillNeeded.trim()),
        `${tooth.id}: caughtOnlyBy answered`,
      );
    }
  }
  const exported = new Map(exportForMutationRunner().map((e) => [e.id, e]));
  for (const id of TOOTH_IDS) {
    assert.ok(exported.has(id), `${id} must be in the mutation-runner export`);
  }
});

test("tooth run functions are the exported checks (single source of truth)", () => {
  const byId = new Map(allTeeth().map((t) => [t.id, t] as const));
  assert.equal(byId.get("artifact-factory.deterministic-build")!.run, checkDeterministicBuild);
  assert.equal(byId.get("artifact-factory.ok-artifact-runs")!.run, checkOkArtifactRuns);
});
