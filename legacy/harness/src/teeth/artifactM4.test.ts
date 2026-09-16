// @invariant — M4 consent & notification teeth self-verification: known-green
// on a clean world, known-red under each declared mutation.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkM4ConfirmNoConsentZeroSideEffects,
  checkM4ConsentBindsVersion,
  checkM4NotifyOnlyReportsInstallableVersion,
} from "../artifact/m4.ts";

const TOOTH_IDS = new Set([
  "m4.confirm-no-consent-zero-side-effects",
  "m4.consent-binds-version",
  "m4.notify-only-reports-installable-version",
]);

const ctxFor = async (prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> => {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
};

test("known-green: every M4 tooth passes on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 3, "all three M4 teeth must be registered");
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

test("known-red: confirm-zero-side-effects catches an auto policy (bytes staged)", async () => {
  const { ctx, teardown } = await ctxFor("red-m4-confirm");
  try {
    // mutation: auto policy — no confirm gate, so the upgrade stages bytes
    await assert.rejects(checkM4ConfirmNoConsentZeroSideEffects(ctx, { policy: "auto" }), /must hold, not install|must exit 0/);
  } finally {
    await teardown();
  }
});

test("known-red: consent-binds-version catches a continuation that installs after the publisher moved on", async () => {
  const { ctx, teardown } = await ctxFor("red-m4-consent");
  try {
    // mutation expectation: the binding was lost — the continuation should
    // have installed the approved version even though the server moved on
    await assert.rejects(
      checkM4ConsentBindsVersion(ctx, { serverSwitched: true, expectInstalled: true }),
      /expectInstalled => RED/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: notify-only catches a confirm policy (no notify-only path)", async () => {
  const { ctx, teardown } = await ctxFor("red-m4-notify");
  try {
    // mutation: confirm policy — the notify-only branch is never taken
    await assert.rejects(
      checkM4NotifyOnlyReportsInstallableVersion(ctx, { policy: "confirm" }),
      /notify-only must hold|policy is notify-only/,
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
  assert.equal(byId.get("m4.confirm-no-consent-zero-side-effects")!.run, checkM4ConfirmNoConsentZeroSideEffects);
  assert.equal(byId.get("m4.consent-binds-version")!.run, checkM4ConsentBindsVersion);
  assert.equal(byId.get("m4.notify-only-reports-installable-version")!.run, checkM4NotifyOnlyReportsInstallableVersion);
});
