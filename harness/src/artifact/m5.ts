/**
 * M5 platform-surface / lifecycle-convergence acceptance checks
 * (test-plan M5 rows: 点名面读回一致；面在 allowlist 才可作证；未注册面被引用
 * ⇒ 拒; fail-closed 退役序; 禁投影).
 *
 * These drive createUpgrader in-process (the library plane — the converge
 * machinery is exactly the kind of internal tooth the black-box plane
 * cannot reach).
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { type ToothContext } from "../teeth/registry.ts";
import { createUpgrader, type CreateUpgraderOptions } from "../../../core/src/createUpgrader.ts";
import { staticManifestSource } from "../../../core/src/artifact/staticManifestSource.ts";
import {
  buildSurfaceAllowlist,
  readAllowlisted,
  evaluateLifecycleConvergence,
} from "../../../core/src/converge/lifecycle.ts";
import type { ReadbackSurface } from "../../../core/src/converge/predicates.ts";
import type { HostAdapter, ProcessEvidence, Slot } from "../../../core/src/lifecycle/hostAdapter.ts";
import { slotArtifactPath } from "../../../core/src/txn/fileEffects.ts";
import { FakeServer } from "../fake-server/server.ts";
import { ArtifactFactory } from "../artifact-factory/factory.ts";

function stateDir(ctx: ToothContext): string {
  return path.join(ctx.sandboxDir, "state");
}

/** A host whose probe reports the started slot's version (swap-like). */
function simpleHost(): HostAdapter {
  let version = "0.0.0";
  let startId = "init";
  return {
    async quiesce() {},
    async stop() {},
    async start(slot: Slot) {
      version = slot === "experiment" ? "2.0.0" : "1.0.0";
      startId = `${slot}-${Math.random().toString(36).slice(2)}`;
    },
    async healthProbe(): Promise<ProcessEvidence> {
      return { version, pid: process.pid, startId };
    },
    async resume() {},
  };
}

function makeSurface(id: string, value: () => Promise<string>): ReadbackSurface {
  return { id, read: async () => ({ value: await value(), source: id }) };
}

async function serveTarget(ctx: ToothContext): Promise<FakeServer> {
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store") });
  await server.start();
  const factory = new ArtifactFactory({ cacheDir: path.join(ctx.sandboxDir, "cache") });
  await factory.makeRelease({
    version: "2.0.0",
    behavior: "ok",
    store: server.store,
    platform: (await import("../../../core/src/artifact/staticManifestSource.ts")).currentPlatformKey(),
  });
  return server;
}

function makeUpgrader(
  ctx: ToothContext,
  server: FakeServer,
  surfaces: ReadbackSurface[],
): ReturnType<typeof createUpgrader> {
  const opts: CreateUpgraderOptions = {
    host: simpleHost(),
    source: staticManifestSource({ baseUrl: server.url }),
    policy: "auto",
    notificationSink: async () => {},
    rootKeys: [server.rootKeyPem],
    stateDir: stateDir(ctx),
    lifecycleSurfaces: surfaces,
  };
  return createUpgrader(opts);
}

// ---------------------------------------------------------------------------
// m5.lifecycle-surface-allowlist
// ---------------------------------------------------------------------------

export async function checkM5LifecycleSurfaceAllowlist(
  ctx: ToothContext,
  opts: { acceptUnknown?: boolean } = {},
): Promise<void> {
  const allowlist = buildSurfaceAllowlist([
    { surface: makeSurface("test.autostart", async () => "registered-path"), expectedTarget: "registered-path" },
  ]);
  if (opts.acceptUnknown) {
    // mutation: an unknown surface id is accepted as evidence — the
    // refusal assertion must go RED
    assert.ok(
      (await readAllowlisted(allowlist, "not-declared")).value.length >= 0,
      "unregistered surface must be refused (acceptUnknown => RED)",
    );
    return;
  }
  // an id not on the allowlist is a typed refusal (未注册面被引用 ⇒ 拒)
  await assert.rejects(readAllowlisted(allowlist, "not-declared"), /UNREGISTERED_SURFACE/);

  // and the evaluator refuses when a declared surface cannot be read
  const broken = await evaluateLifecycleConvergence(
    buildSurfaceAllowlist([
      {
        surface: makeSurface("broken.autostart", async () => {
          throw new Error("surface cannot be read on this machine");
        }),
        expectedTarget: "x",
      },
    ]),
    0,
  );
  assert.equal(broken.passed, false, "an unreadable surface cannot vouch for convergence");
  assert.match(broken.source, /broken\.autostart/);
}

// ---------------------------------------------------------------------------
// m5.lifecycle-converged-promotes
// ---------------------------------------------------------------------------

export async function checkM5LifecycleConvergedPromotes(
  ctx: ToothContext,
  opts: { staleSurface?: boolean } = {},
): Promise<void> {
  const server = await serveTarget(ctx);
  try {
    const dir = stateDir(ctx);
    const target = slotArtifactPath(dir, "experiment");
    const stale = path.join(dir, "slots", "stable", "artifact.bin");
    const surface = opts.staleSurface
      ? { id: "test.autostart", read: async () => ({ value: stale, source: "test.autostart" }) }
      : { id: "test.autostart", read: async () => ({ value: target, source: "test.autostart" }) };
    const upgrader = makeUpgrader(ctx, server, [surface]);
    const outcome = await upgrader.upgrade();
    if (opts.staleSurface) {
      // mutation: the surface reads back the OLD path — the predicate must
      // refuse, so the promote assertion goes RED
      assert.equal(
        outcome.result,
        "promoted",
        "convergence requires the surface to read back the new artifact (staleSurface => RED)",
      );
      return;
    }
    assert.equal(outcome.result, "promoted", "a converged surface must allow the promote");
    assert.equal(
      outcome.report?.hostLifecycleConverged.passed,
      true,
      "the report must carry the real converged predicate",
    );
    assert.equal(outcome.report?.hostLifecycleConverged.source, "test.autostart");
    assert.equal(outcome.report?.binaryAtTarget.passed, true);
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// m5.lifecycle-projection-ban
// ---------------------------------------------------------------------------

export async function checkM5LifecycleProjectionBan(
  ctx: ToothContext,
  opts: { acceptProjection?: boolean } = {},
): Promise<void> {
  // projection: the surface value is the VERSION string (metadata), not the
  // artifact path — it must never satisfy host_lifecycle_converged
  const projection = makeSurface("test.autostart", async () => "2.0.0");
  const result = await evaluateLifecycleConvergence(
    buildSurfaceAllowlist([
      { surface: projection, expectedTarget: slotArtifactPath(stateDir(ctx), "experiment") },
    ]),
    0,
  );
  if (opts.acceptProjection) {
    // mutation expectation: the projection IS accepted as convergence — the
    // real evaluator refuses it, so this assertion must go RED
    assert.equal(result.passed, true, "metadata must not green the predicate (acceptProjection => RED)");
    return;
  }
  assert.equal(result.passed, false, "a version string is not lifecycle evidence (projection ban)");
  assert.match(JSON.stringify(result.detail), /does not reference the installed artifact path/);

  // end to end: the upgrade with a projecting surface refuses to promote
  const server = await serveTarget(ctx);
  try {
    const upgrader = makeUpgrader(ctx, server, [projection]);
    const outcome = await upgrader.upgrade();
    assert.notEqual(outcome.result, "promoted", "a projecting surface must block the promote");
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// m5.lifecycle-fail-closed-retirement
// ---------------------------------------------------------------------------

export async function checkM5LifecycleFailClosedRetirement(
  ctx: ToothContext,
  opts: { retireUnconditionally?: boolean } = {},
): Promise<void> {
  const server = await serveTarget(ctx);
  try {
    // the surface reads back the OLD path: convergence fails
    const stale = path.join(stateDir(ctx), "slots", "stable", "artifact.bin");
    const surface = { id: "test.autostart", read: async () => ({ value: stale, source: "test.autostart" }) };
    const upgrader = makeUpgrader(ctx, server, [surface]);
    const outcome = await upgrader.upgrade();
    assert.notEqual(outcome.result, "promoted", "the non-converged upgrade must not promote");

    const retire = await upgrader.retireLegacyManager();
    if (opts.retireUnconditionally) {
      // mutation: retirement ignores convergence — the HOLD assertion goes RED
      assert.equal(retire, "retired", "retirement before convergence must be a HOLD (unconditional => RED)");
      return;
    }
    assert.notEqual(retire, "retired", "retirement before convergence is a typed HOLD");
    assert.match((retire as { held: string }).held, /before host_lifecycle_converged passed/);

    // after a CONVERGED promote, retirement is allowed
    const goodServer = await serveTarget(ctx);
    try {
      const dir = stateDir(ctx);
      const target = slotArtifactPath(dir, "experiment");
      const goodSurface = { id: "test.autostart", read: async () => ({ value: target, source: "test.autostart" }) };
      const up2 = makeUpgrader(ctx, goodServer, [goodSurface]);
      const good = await up2.upgrade();
      assert.equal(good.result, "promoted");
      assert.equal(await up2.retireLegacyManager(), "retired", "post-convergence retirement is allowed");
    } finally {
      await goodServer.stop();
    }
  } finally {
    await server.stop();
  }
}

