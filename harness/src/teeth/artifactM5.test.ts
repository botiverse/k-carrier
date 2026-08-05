// @invariant — M5 platform-surface / lifecycle-convergence teeth
// self-verification: known-green on a clean world, known-red under each
// declared mutation.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkM5LifecycleSurfaceAllowlist,
  checkM5LifecycleConvergedPromotes,
  checkM5LifecycleProjectionBan,
  checkM5LifecycleFailClosedRetirement,
} from "../artifact/m5.ts";

const TOOTH_IDS = new Set([
  "m5.lifecycle-surface-allowlist",
  "m5.lifecycle-converged-promotes",
  "m5.lifecycle-projection-ban",
  "m5.lifecycle-fail-closed-retirement",
]);

const ctxFor = async (prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> => {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
};

test("known-green: every M5 tooth passes on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 4, "all four M5 teeth must be registered");
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

test("known-red: surface-allowlist catches an accepted unknown surface", async () => {
  const { ctx, teardown } = await ctxFor("red-m5-allowlist");
  try {
    await assert.rejects(checkM5LifecycleSurfaceAllowlist(ctx, { acceptUnknown: true }), /UNREGISTERED_SURFACE/);
  } finally {
    await teardown();
  }
});

test("known-red: converged-promotes catches a stale surface read-back", async () => {
  const { ctx, teardown } = await ctxFor("red-m5-converged");
  try {
    await assert.rejects(checkM5LifecycleConvergedPromotes(ctx, { staleSurface: true }), /staleSurface => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: projection-ban catches an accepted projection", async () => {
  const { ctx, teardown } = await ctxFor("red-m5-projection");
  try {
    await assert.rejects(checkM5LifecycleProjectionBan(ctx, { acceptProjection: true }), /acceptProjection => RED/);
  } finally {
    await teardown();
  }
});

test("known-red: fail-closed-retirement catches unconditional retirement", async () => {
  const { ctx, teardown } = await ctxFor("red-m5-retire");
  try {
    await assert.rejects(
      checkM5LifecycleFailClosedRetirement(ctx, { retireUnconditionally: true }),
      /unconditional => RED/,
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
  assert.equal(byId.get("m5.lifecycle-surface-allowlist")!.run, checkM5LifecycleSurfaceAllowlist);
  assert.equal(byId.get("m5.lifecycle-converged-promotes")!.run, checkM5LifecycleConvergedPromotes);
  assert.equal(byId.get("m5.lifecycle-projection-ban")!.run, checkM5LifecycleProjectionBan);
  assert.equal(byId.get("m5.lifecycle-fail-closed-retirement")!.run, checkM5LifecycleFailClosedRetirement);
});
