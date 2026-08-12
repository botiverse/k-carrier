// @invariant — M6 drive + policy-gate teeth self-verification: known-green
// on a clean world, known-red under each declared mutation (one negative
// control per conjunct — an AND gate needs as many negative
// controls as it has conjuncts).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkM6DriveStageThroughPolicy,
  checkM6DrivePromoteThroughPolicy,
  checkM6DriveRollbackThroughOwnership,
  checkM6RollbackSettlesInflightOwnershipFlip,
  checkM6PushRollbackThroughPolicy,
  checkM6AutoRollbackNeedsNoConsent,
} from "../artifact/m6Drive.ts";

const TOOTH_IDS = new Set([
  "m6.drive-stage-through-policy",
  "m6.drive-promote-through-policy",
  "m6.drive-rollback-through-ownership",
  "m6.rollback-settles-inflight-ownership-flip",
  "m6.push-rollback-through-policy",
  "m6.auto-rollback-needs-no-consent",
]);

const ctxFor = async (prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> => {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
};

test("known-green: every M6 drive tooth passes on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 6, "all six M6 drive teeth must be registered");
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

test("known-red: drive-stage catches a stage without consent", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-drive-stage");
  try {
    await assert.rejects(
      checkM6DriveStageThroughPolicy(ctx, { stageWithoutConsent: true }),
      /never a stage/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: drive-stage catches a held stage recorded in provenance", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-drive-stage-journal");
  try {
    await assert.rejects(
      checkM6DriveStageThroughPolicy(ctx, { journalHeldStage: true }),
      /provenance journal stays untouched/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: drive-promote catches a promote without consent", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-drive-promote");
  try {
    await assert.rejects(
      checkM6DrivePromoteThroughPolicy(ctx, { promoteWithoutConsent: true }),
      /never a HOLD|without consent is a HOLD/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: drive-promote catches an install of a different version than approved", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-drive-other-version");
  try {
    await assert.rejects(
      checkM6DrivePromoteThroughPolicy(ctx, { installOtherVersion: true }),
      /consent binds/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: drive-rollback catches a rollback ignoring ownership", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-drive-rollback");
  try {
    await assert.rejects(
      checkM6DriveRollbackThroughOwnership(ctx, { rollbackIgnoringOwnership: true }),
      /typed held/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: settles-inflight catches a held mid-transaction (the brick)", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-inflight");
  try {
    await assert.rejects(
      checkM6RollbackSettlesInflightOwnershipFlip(ctx, { holdInFlightRollback: true }),
      /is a brick/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: push-rollback catches a bypassed policy gate", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-push-rollback");
  try {
    await assert.rejects(
      checkM6PushRollbackThroughPolicy(ctx, { bypassPushRollbackPolicy: true }),
      /must hold until consent|without consent is a HOLD/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: auto-rollback catches an auto-rollback gated on consent", async () => {
  const { ctx, teardown } = await ctxFor("red-m6-auto-rollback");
  try {
    await assert.rejects(
      checkM6AutoRollbackNeedsNoConsent(ctx, { gateAutoRollback: true }),
      /must never ask for consent|you'll always get back/,
    );
  } finally {
    await teardown();
  }
});

test("registration discipline: profiles/layers/kind/mustRed/capability all answered", () => {
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
    // gate by what the tooth NEEDS: the drive teeth need the drive surface
    if (tooth.id.startsWith("m6.drive-") || tooth.id === "m6.push-rollback-through-policy") {
      assert.equal(tooth.requiresCapability, "fleet-drive", `${tooth.id}: needs fleet-drive`);
    } else {
      assert.equal(tooth.requiresCapability, undefined, `${tooth.id}: no unrelated capability`);
    }
  }
  const exported = new Map(exportForMutationRunner().map((e) => [e.id, e]));
  for (const id of TOOTH_IDS) assert.ok(exported.has(id), `${id} must be in the mutation-runner export`);
});

test("tooth run functions are the exported checks (single source of truth)", () => {
  const byId = new Map(allTeeth().map((t) => [t.id, t] as const));
  assert.equal(byId.get("m6.drive-stage-through-policy")!.run, checkM6DriveStageThroughPolicy);
  assert.equal(byId.get("m6.drive-promote-through-policy")!.run, checkM6DrivePromoteThroughPolicy);
  assert.equal(byId.get("m6.drive-rollback-through-ownership")!.run, checkM6DriveRollbackThroughOwnership);
  assert.equal(byId.get("m6.rollback-settles-inflight-ownership-flip")!.run, checkM6RollbackSettlesInflightOwnershipFlip);
  assert.equal(byId.get("m6.push-rollback-through-policy")!.run, checkM6PushRollbackThroughPolicy);
  assert.equal(byId.get("m6.auto-rollback-needs-no-consent")!.run, checkM6AutoRollbackNeedsNoConsent);
});
