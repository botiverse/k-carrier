// @invariant — black-box target discipline: a binary without k.target.ts
// must be a typed BLACKBOX_TARGET_REQUIRED FAIL (never a guess), and a
// present target must load.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import { checkMissingTargetFails } from "../targetCheck.ts";

const TOOTH_ID = "blackbox.missing-target-fails";

async function ctxFor(prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "managed", sandboxDir: sb.dir }, teardown: sb.teardown };
}

test("known-green: a binary without k.target.ts fails with BLACKBOX_TARGET_REQUIRED", async () => {
  const tooth = allTeeth().find((t) => t.id === TOOTH_ID);
  assert.ok(tooth, "blackbox.missing-target-fails must be registered");
  const { ctx, teardown } = await ctxFor("green-target");
  try {
    await tooth!.run(ctx); // must not throw: the missing-target FAIL is the expected outcome
  } catch (err) {
    assert.fail(`tooth went RED on a clean world: ${(err as Error).message}`);
  } finally {
    await teardown();
  }
});

test("known-red: with a target file present the tooth goes red", async () => {
  const { ctx, teardown } = await ctxFor("red-target");
  try {
    await assert.rejects(
      checkMissingTargetFails(ctx, { withTarget: true }),
      /must fail with an actionable typed error/,
    );
  } finally {
    await teardown();
  }
});

test("registration discipline: profiles/layers/kind/mustRed answered", () => {
  const tooth = allTeeth().find((t) => t.id === TOOTH_ID)!;
  assert.equal(tooth.kind.kind, "invariant");
  assert.ok(tooth.profiles.length > 0);
  assert.ok(tooth.mustRed.length > 0);
  assert.ok(exportForMutationRunner().some((e) => e.id === TOOTH_ID));
});
