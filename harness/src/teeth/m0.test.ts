// @invariant — M0 teeth self-verification: every registered tooth runs
// GREEN on a clean world (known-green) and RED under its declared must-red
// mutation (known-red), exactly what the mutation-runner will demand later.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./m0.ts"; // registers the teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkServesVerifiableRelease,
  checkCorruptByteRejects,
  checkSwapSigRejects,
  checkServeOlderVersion,
  checkDropFileRemoves,
  checkSandboxIsolation,
  assertSandboxDistinct,
  assertDirGone,
  M0_ARTIFACT,
} from "./checks.ts";
import { sigFileFor } from "../fake-server/manifest.ts";

const M0_TOOTH_IDS = new Set([
  "fake-server.serves-verifiable-release",
  "fake-server.tamper-corrupt-byte",
  "fake-server.tamper-swap-sig",
  "fake-server.tamper-serve-older-version",
  "fake-server.tamper-drop-file",
  "scenario.sandbox-isolation",
]);

const ctxFor = async (prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> => {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "managed", sandboxDir: sb.dir }, teardown: sb.teardown };
};

// ---------------------------------------------------------------------------
// known-green: each M0 tooth passes on a clean sandbox
// ---------------------------------------------------------------------------

test("known-green: every M0 tooth passes on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => M0_TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 6, "all M0 teeth must be registered");
  for (const tooth of teeth) {
    const { ctx, teardown } = await ctxFor(tooth.id.replaceAll(".", "-"));
    try {
      await tooth.run(ctx); // throws on violation
    } catch (err) {
      assert.fail(`tooth ${tooth.id} went RED on a clean world: ${(err as Error).message}`);
    } finally {
      await teardown();
    }
  }
});

// ---------------------------------------------------------------------------
// known-red: each tooth must go red under its declared must-red mutation
// ---------------------------------------------------------------------------

test("known-red: serves-verifiable-release catches a release missing artifact signatures", async () => {
  const { ctx, teardown } = await ctxFor("red-unsigned");
  try {
    // mutation: publish a release and drop its artifact .sig before serving
    await assert.rejects(
      checkServesVerifiableRelease(ctx, async (s) => {
        await s.dropFile(sigFileFor(M0_ARTIFACT));
      }),
      /must be served|must verify/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: tamper-corruptByte catches a no-op corruptByte", async () => {
  const { ctx, teardown } = await ctxFor("red-corrupt");
  try {
    await assert.rejects(
      checkCorruptByteRejects(ctx, async () => {}), // mutation: corruptByte does nothing
      /FAIL signature verification/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: tamper-swapSig catches a no-op swapSig", async () => {
  const { ctx, teardown } = await ctxFor("red-swap");
  try {
    await assert.rejects(
      checkSwapSigRejects(ctx, async () => {}), // mutation: swapSig does nothing
      /FAIL verification/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: tamper-serveOlderVersion catches a no-op downgrade", async () => {
  const { ctx, teardown } = await ctxFor("red-older");
  try {
    await assert.rejects(
      checkServeOlderVersion(ctx, async (s) => {
        // mutation: serveOlderVersion reports the current version, changes nothing
        return s.active ?? "";
      }),
      /must switch to the older release/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: tamper-dropFile catches a no-op dropFile", async () => {
  const { ctx, teardown } = await ctxFor("red-drop");
  try {
    await assert.rejects(
      checkDropFileRemoves(ctx, async () => {}), // mutation: dropFile does nothing
      /must no longer be served/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: sandbox-isolation catches shared dir/port and leftover dirs", async () => {
  assert.throws(
    () => assertSandboxDistinct({ dir: "/same", port: 1234 }, { dir: "/same", port: 1234 }),
    /distinct/,
  );
  const sb = await createSandbox({ prefix: "red-iso" });
  try {
    await assert.rejects(assertDirGone(sb.dir), "an existing dir must fail assertDirGone");
  } finally {
    await sb.teardown();
  }
});

// ---------------------------------------------------------------------------
// registration discipline: the teeth were forced through the registry
// ---------------------------------------------------------------------------

test("M0 teeth are registered with full discipline (profiles/layers/kind/mustRed)", () => {
  const teeth = allTeeth().filter((t) => M0_TOOTH_IDS.has(t.id));
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
});

test("tooth run functions are the exported checks (single source of truth)", () => {
  const byId = new Map(allTeeth().map((t) => [t.id, t] as const));
  assert.equal(byId.get("fake-server.serves-verifiable-release")!.run, checkServesVerifiableRelease);
  assert.equal(byId.get("fake-server.tamper-corrupt-byte")!.run, checkCorruptByteRejects);
  assert.equal(byId.get("fake-server.tamper-swap-sig")!.run, checkSwapSigRejects);
  assert.equal(byId.get("fake-server.tamper-serve-older-version")!.run, checkServeOlderVersion);
  assert.equal(byId.get("fake-server.tamper-drop-file")!.run, checkDropFileRemoves);
  assert.equal(byId.get("scenario.sandbox-isolation")!.run, checkSandboxIsolation);
});

test("mutation-runner export carries the M0 must-red lists", () => {
  const exported = new Map(exportForMutationRunner().map((e) => [e.id, e]));
  for (const id of M0_TOOTH_IDS) {
    assert.ok(exported.has(id), `${id} must be in the mutation-runner export`);
    assert.ok(exported.get(id)!.mustRed.length > 0);
  }
});
