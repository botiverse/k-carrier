// @invariant — examples teeth self-verification: the three demos are each
// profile's support-claim credential; they must be known-green on a clean
// world and known-red under their declared mutations.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkCliToolBlackbox,
  checkPlainDaemonContract,
  checkManagedHostAdapter,
} from "../examples/checks.ts";
import type { HostDriver } from "../fake-host/inproc.ts";

const TOOTH_IDS = new Set([
  "examples.swap-tool-blackbox",
  "examples.service-daemon-contract",
  "examples.hosted-service-adapter",
]);

async function ctxFor(prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
}

// ---------------------------------------------------------------------------
// known-green
// ---------------------------------------------------------------------------

test("known-green: every examples tooth passes on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  assert.equal(teeth.length, 3, "all three examples teeth must be registered");
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

// ---------------------------------------------------------------------------
// known-red
// ---------------------------------------------------------------------------

test("known-red: swap-tool catches a self-upgrade that swaps no bytes", async () => {
  const { ctx, teardown } = await ctxFor("red-swap-tool");
  try {
    // mutation: the served release is the CURRENT version, so the upgrade
    // swaps identical bytes — the on-disk change assertion must go red
    await assert.rejects(
      checkCliToolBlackbox(ctx, { serveSameVersion: true }),
      /must change the binary bytes/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: service-daemon catches a daemon that crashes on start", async () => {
  const { ctx, teardown } = await ctxFor("red-daemon");
  try {
    await assert.rejects(
      checkPlainDaemonContract(ctx, { behavior: "crash-on-start" }),
      /timed out waiting for "ready"/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: hosted-service catches a host that loses the session on resume", async () => {
  const { ctx, teardown } = await ctxFor("red-managed");
  try {
    // mutation: resume cannot restore the parked ledger — a broken adopter
    // host. Delegated explicitly (spread would freeze the getters).
    const real = (await import("../../../examples/hosted-service/host.ts")).createManagedHost(
      path.join(ctx.sandboxDir, "host"),
    );
    const broken: HostDriver = {
      quiesce: real.quiesce,
      stop: real.stop,
      start: real.start,
      healthProbe: real.healthProbe,
      resume: async () => {
        throw new Error("resume lost the session ledger"); // mutation
      },
      get running() {
        return real.running;
      },
      get parked() {
        return real.parked;
      },
      get startId() {
        return real.startId;
      },
      doWork: real.doWork!,
      ledger: real.ledger!,
      ledgerState: real.ledgerState!,
    };
    await assert.rejects(
      checkManagedHostAdapter(ctx, { hostOverride: () => broken }),
      /resume lost the session ledger/,
    );
  } finally {
    await teardown();
  }
});

// ---------------------------------------------------------------------------
// registration discipline
// ---------------------------------------------------------------------------

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

test("each examples tooth is tagged to exactly its own profile tier", () => {
  const byId = new Map(allTeeth().map((t) => [t.id, t] as const));
  assert.deepEqual(byId.get("examples.swap-tool-blackbox")!.profiles, ["swap"]);
  assert.deepEqual(byId.get("examples.service-daemon-contract")!.profiles, ["service"]);
  assert.deepEqual(byId.get("examples.hosted-service-adapter")!.profiles, ["service"]);
});

test("tooth run functions are the exported checks (single source of truth)", () => {
  const byId = new Map(allTeeth().map((t) => [t.id, t] as const));
  assert.equal(byId.get("examples.swap-tool-blackbox")!.run, checkCliToolBlackbox);
  assert.equal(byId.get("examples.service-daemon-contract")!.run, checkPlainDaemonContract);
  assert.equal(byId.get("examples.hosted-service-adapter")!.run, checkManagedHostAdapter);
});
