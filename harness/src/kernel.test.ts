// @invariant K v2 durable protocol and deterministic crash recovery teeth.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cause, Exit, ManagedRuntime } from "effect";
import { recoverEffect, upgradeEffect } from "../../src/effect.ts";
import { makeHarnessLayer } from "./layer.ts";
import { makeWorld } from "./model.ts";

const request = {
  operationId: "upgrade-1",
  targetVersion: "2.0.0",
} as const;

describe("Effect-native K kernel", () => {
  it("writes durable intents before effects and promotes a verified target", async () => {
    const world = makeWorld();
    const runtime = ManagedRuntime.make(makeHarnessLayer(world));

    const outcome = await runtime.runPromise(upgradeEffect(request));
    await runtime.dispose();

    assert.deepEqual(outcome, {
      _tag: "Promoted",
      operationId: "upgrade-1",
      version: "2.0.0",
    });
    assert.equal(world.stable.version, "2.0.0");
    assert.equal(world.experiment, null);
    assert.equal(world.running, "stable");
    assert.equal(world.quiesced, false);
    assert.deepEqual(
      world.journal.map((entry) => entry.phase),
      [
        "staged",
        "handover",
        "experiment_running",
        "verifying",
        "committed",
      ],
    );
    assert.equal(world.journal[0]?.at, 1_700_000_000_001);
    assert.ok(
      world.trace.indexOf("journal:staged#1") <
        world.trace.indexOf("slots:stage#1"),
    );
    assert.ok(
      world.trace.indexOf("journal:handover#1") <
        world.trace.indexOf("host:quiesce#1"),
    );
    assert.ok(
      world.trace.indexOf("journal:committed#1") <
        world.trace.indexOf("slots:promote#1"),
    );
  });

  it("rolls back after a verification refusal", async () => {
    const world = makeWorld();
    const runtime = ManagedRuntime.make(
      makeHarnessLayer(world, { refuseVerification: true }),
    );

    const outcome = await runtime.runPromise(upgradeEffect(request));
    await runtime.dispose();

    assert.equal(outcome._tag, "RolledBack");
    assert.equal(world.stable.version, "1.0.0");
    assert.equal(world.running, "stable");
    assert.equal(world.experiment, null);
    assert.equal(world.journal.at(-1)?.phase, "rolled_back");
  });

  it("does not retry or roll back an uncertain host mutation", async () => {
    const world = makeWorld();
    const runtime = ManagedRuntime.make(
      makeHarnessLayer(world, {
        unknownAfter: "host:start:experiment#1",
      }),
    );

    const exit = await runtime.runPromiseExit(upgradeEffect(request));
    await runtime.dispose();

    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      assert.match(Cause.pretty(exit.cause), /HostOutcomeUnknown/);
    }
    assert.equal(world.sideEffects.get("host:start:experiment"), 1);
    assert.equal(world.running, "experiment");
    assert.equal(world.journal.at(-1)?.phase, "handover");

    const recovery = ManagedRuntime.make(makeHarnessLayer(world));
    await recovery.runPromise(recoverEffect(request.operationId));
    await recovery.dispose();
    assert.equal(world.sideEffects.get("host:start:experiment"), 1);
    assert.equal(world.journal.at(-1)?.phase, "committed");
    assert.equal(world.stable.version, "2.0.0");
    assert.equal(world.running, "stable");
  });

  it("converges after a fresh-process crash at every observed boundary", async () => {
    const golden = makeWorld();
    const goldenRuntime = ManagedRuntime.make(makeHarnessLayer(golden));
    await goldenRuntime.runPromise(upgradeEffect(request));
    await goldenRuntime.dispose();
    const boundaries = [...golden.trace];
    assert.ok(boundaries.length >= 18);

    for (const boundary of boundaries) {
      const world = makeWorld();
      const firstBoot = ManagedRuntime.make(
        makeHarnessLayer(world, { crashAfter: boundary }),
      );
      const exit = await firstBoot.runPromiseExit(upgradeEffect(request));
      await firstBoot.dispose();
      assert.equal(Exit.isFailure(exit), true, boundary);

      // A process-scoped lock is gone after a real process death. Durable
      // journal, slots, host state, and idempotency receipts survive.
      world.lockHeld = false;
      const secondBoot = ManagedRuntime.make(makeHarnessLayer(world));
      await secondBoot.runPromise(recoverEffect(request.operationId));
      await secondBoot.dispose();

      assert.equal(world.lockHeld, false, boundary);
      assert.equal(world.running, "stable", boundary);
      assert.equal(world.quiesced, false, boundary);
      assert.equal(world.experiment, null, boundary);
      assert.ok(
        world.journal.length === 0 ||
          ["committed", "rolled_back"].includes(
            world.journal.at(-1)?.phase ?? "",
          ),
        boundary,
      );
      assert.ok(
        world.stable.version === "1.0.0" ||
          world.stable.version === "2.0.0",
        boundary,
      );
    }
  });
});
