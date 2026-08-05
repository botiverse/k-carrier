// @invariant — M1 artifact teeth self-verification: known-green on a clean
// world, known-red under each declared mutation.
import { test } from "node:test";

/** A source that serves ANY platform and ANY version asked for: it guesses. */
const lenientSource = (version: string) => ({
  checkForUpdate: async () => ({ version, url: "https://x/a.bin", sha256: "a".repeat(64), size: 1 }),
  fetchRelease: async (v: string) => ({ version: v, url: "https://x/a.bin", sha256: "a".repeat(64), size: 1 }),
});
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkTamperedArtifactRefused,
  checkKillMidSwapPreservesOld,
  checkSourceFailsClosed,
} from "../artifact/checks.ts";

const TOOTH_IDS = new Set([
  "artifact.tamper-refuses-install",
  "artifact.atomic-swap-crash-safe",
  "artifact.source-fails-closed",
]);

async function ctxFor(prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
}

test("known-green: every M1 artifact tooth passes on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 3, "all three artifact teeth must be registered");
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

test("known-red: tamper-refuses-install catches a verification that never happens", async () => {
  const { ctx, teardown } = await ctxFor("red-tamper");
  try {
    await assert.rejects(
      checkTamperedArtifactRefused(ctx, { skipTamper: true }),
      /must be refused/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: atomic-swap-crash-safe catches a swap that completes (no kill)", async () => {
  const { ctx, teardown } = await ctxFor("red-swap");
  try {
    await assert.rejects(
      checkKillMidSwapPreservesOld(ctx, { skipKill: true }),
      /old bytes intact/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: source-fails-closed catches a source that guesses instead of refusing", async () => {
  const { ctx, teardown } = await ctxFor("red-source");
  try {
    // mutation: a source that serves ANY platform and ANY version it is asked
    // for — i.e. it guesses rather than refusing. The tooth must go red.
    await assert.rejects(checkSourceFailsClosed(ctx, lenientSource));
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
  assert.equal(byId.get("artifact.tamper-refuses-install")!.run, checkTamperedArtifactRefused);
  assert.equal(byId.get("artifact.atomic-swap-crash-safe")!.run, checkKillMidSwapPreservesOld);
  assert.equal(byId.get("artifact.source-fails-closed")!.run, checkSourceFailsClosed);
});
