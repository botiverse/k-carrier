/**
 * Adapter-mode service checks — the SAME assertions as the service-profile
 * teeth (m3.service-upgrade / m3.service-rollback, m5.lifecycle-converged-
 * promotes), but with the HOST SWAPPED for an external adopter adapter
 * (archer: "同一套齿，换一个宿主实现"). The teeth use ONLY the five
 * HostAdapter responsibilities + the app-declared lifecycle surfaces — no
 * test backdoors (transparency §1.8).
 *
 * These drive createUpgrader in-process (the library plane) against the
 * adapter's host + a real signed fake-server release.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { type ToothContext } from "../teeth/registry.ts";
import { createUpgrader } from "../../../core/src/createUpgrader.ts";
import { staticManifestSource } from "../../../core/src/artifact/staticManifestSource.ts";
import type { HostAdapter } from "../../../core/src/lifecycle/hostAdapter.ts";
import type { HostDriver } from "../fake-host/inproc.ts";
import type { ReadbackSurface } from "../../../core/src/converge/predicates.ts";
import { slotArtifactPath } from "../../../core/src/txn/fileEffects.ts";
import { processAlive } from "../fake-host/daemon.ts";
import { serveRelease } from "../artifact/m1.ts";
import { PLAIN_DAEMON_SOURCE } from "../../../examples/service-daemon/source.ts";

/** The adopter module's factory contract for the service tier. */
export type ServiceAdapterFactory = (stateDir: string) => HostDriver & {
  lifecycleSurfaces?: () => ReadbackSurface[];
};

function stateDir(ctx: ToothContext): string {
  return path.join(ctx.sandboxDir, "state");
}

function makeUpgrader(ctx: ToothContext, adapter: HostAdapter, baseUrl: string, surfaces?: ReadbackSurface[]) {
  const opts: import("../../../core/src/createUpgrader.ts").CreateUpgraderOptions = {
    host: adapter,
    source: staticManifestSource({ baseUrl }),
    policy: "auto",
    notificationSink: async () => {},
    stateDir: stateDir(ctx),
  };
  if (surfaces !== undefined) opts.lifecycleSurfaces = surfaces;
  return createUpgrader(opts);
}

/** The running successor's evidence, read through the adapter's probe. */
async function successorEvidence(adapter: HostAdapter) {
  return adapter.healthProbe();
}

// ---------------------------------------------------------------------------
// adapter.service-upgrade
// ---------------------------------------------------------------------------

export async function checkAdapterServiceUpgrade(
  ctx: ToothContext,
  adapterFactory: ServiceAdapterFactory,
  opts: { serveBadVersion?: boolean } = {},
): Promise<void> {
  const adapter = adapterFactory(stateDir(ctx));
  const seed = await serveRelease(ctx, {
    version: "1.0.0",
    behavior: "ok",
    name: "adapter-seed",
    source: PLAIN_DAEMON_SOURCE,
  });
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: opts.serveBadVersion ? "crash-on-start" : "ok",
    name: "adapter-target",
    source: PLAIN_DAEMON_SOURCE,
  });
  try {
    // seed: a real upgrade with the adapter host lands stable 1.0.0
    const seedUp = makeUpgrader(ctx, adapter, seed.url);
    const seeded = await seedUp.upgrade();
    assert.equal(seeded.result, "promoted", `seed upgrade must promote (${seeded.result})`);

    const old = await successorEvidence(adapter);
    assert.ok(processAlive(old.pid), "the seeded successor must be alive");

    // the real upgrade: same adapter, new release
    const up = makeUpgrader(ctx, adapter, target.url);
    const outcome = await up.upgrade();
    if (opts.serveBadVersion) {
      // mutation: a bad version — the adapter's probe fails, auto-rollback,
      // so the promote assertion goes RED
      assert.equal(
        outcome.result,
        "promoted",
        "a good upgrade must promote (serveBadVersion mutation => RED)",
      );
      return;
    }
    assert.equal(outcome.result, "promoted", `the adapter-hosted upgrade must promote (${outcome.result})`);
    assert.ok(!processAlive(old.pid), "the OLD incarnation must be verified dead");
    const fresh = await successorEvidence(adapter);
    assert.equal(fresh.version, "2.0.0", "the successor must run the new version");
    assert.ok(processAlive(fresh.pid), "the new successor must be alive");
    assert.notEqual(fresh.startId, old.startId, "the successor is a fresh incarnation (new startId)");
    assert.equal(outcome.report?.binaryAtTarget.passed, true, "the report carries the real predicate");

    const st = await up.state();
    assert.equal(st.stableVersion, "2.0.0");
    assert.equal(st.phase, "promoted");
  } finally {
    await adapter.stop("experiment").catch(() => {});
    await seed.stop();
    await target.stop();
  }
}

// ---------------------------------------------------------------------------
// adapter.service-rollback
// ---------------------------------------------------------------------------

export async function checkAdapterServiceRollback(
  ctx: ToothContext,
  adapterFactory: ServiceAdapterFactory,
  opts: { serveGoodVersion?: boolean } = {},
): Promise<void> {
  const adapter = adapterFactory(stateDir(ctx));
  const seed = await serveRelease(ctx, {
    version: "1.0.0",
    behavior: "ok",
    name: "adapter-seed",
    source: PLAIN_DAEMON_SOURCE,
  });
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: opts.serveGoodVersion ? "ok" : "crash-on-start",
    name: "adapter-target",
    source: PLAIN_DAEMON_SOURCE,
  });
  try {
    const seedUp = makeUpgrader(ctx, adapter, seed.url);
    const seeded = await seedUp.upgrade();
    assert.equal(seeded.result, "promoted", `seed upgrade must promote (${seeded.result})`);
    const old = await successorEvidence(adapter);

    const up = makeUpgrader(ctx, adapter, target.url);
    await up.upgrade();
    const st = await up.state();
    if (opts.serveGoodVersion) {
      // mutation: a GOOD version — it promotes, so the rollback expectation
      // goes RED
      assert.equal(st.phase, "rolled-back", "a bad version must roll back (good => RED)");
      return;
    }
    assert.equal(st.phase, "rolled-back", "the adapter-hosted rollback must land rolled-back");
    assert.equal(st.stableVersion, "1.0.0");
    assert.equal(st.experimentVersion, null, "experiment slot must be cleared");
    assert.ok(!processAlive(old.pid), "the pre-upgrade incarnation must stay dead");
    // the old version must be pulled back AND actually running
    const running = await successorEvidence(adapter);
    assert.equal(running.version, "1.0.0", "the pulled-back service must be the old version");
    assert.ok(processAlive(running.pid), "the pulled-back service must be ACTUALLY running");
  } finally {
    await adapter.stop("experiment").catch(() => {});
    await seed.stop();
    await target.stop();
  }
}

// ---------------------------------------------------------------------------
// adapter.lifecycle-converged
// ---------------------------------------------------------------------------

export async function checkAdapterLifecycleConverged(
  ctx: ToothContext,
  adapterFactory: ServiceAdapterFactory,
  opts: { staleSurface?: boolean } = {},
): Promise<void> {
  const adapter = adapterFactory(stateDir(ctx));
  const surfaces = adapter.lifecycleSurfaces?.() ?? [];
  assert.ok(surfaces.length > 0, "the service adapter must declare lifecycle surfaces");
  const surfacesToUse: ReadbackSurface[] = opts.staleSurface
    ? [
        {
          id: "adapter.autostart-stale",
          read: async () => ({
            value: slotArtifactPath(stateDir(ctx), "stable"),
            source: "adapter.autostart-stale",
          }),
        },
      ]
    : surfaces;

  const seed = await serveRelease(ctx, {
    version: "1.0.0",
    behavior: "ok",
    name: "adapter-seed",
    source: PLAIN_DAEMON_SOURCE,
  });
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: "ok",
    name: "adapter-target",
    source: PLAIN_DAEMON_SOURCE,
  });
  try {
    const seedUp = makeUpgrader(ctx, adapter, seed.url, surfacesToUse);
    const seeded = await seedUp.upgrade();
    assert.equal(seeded.result, "promoted", `seed upgrade must promote (${seeded.result})`);

    const up = makeUpgrader(ctx, adapter, target.url, surfacesToUse);
    const outcome = await up.upgrade();
    if (opts.staleSurface) {
      // mutation: the surface reads back the OLD path — convergence fails,
      // so the promote assertion goes RED
      assert.equal(
        outcome.result,
        "promoted",
        "convergence requires the surface to read back the new artifact (staleSurface => RED)",
      );
      return;
    }
    assert.equal(outcome.result, "promoted", `the converged upgrade must promote (${outcome.result})`);
    assert.equal(outcome.report?.hostLifecycleConverged?.passed, true, "the report carries the real convergence");
    assert.match(outcome.report?.hostLifecycleConverged?.source ?? "", /adapter\.autostart/);
    // the surface registered the auto-start for the artifact that was
    // promoted (the experiment path the convergence verified)
    const surfaceRead = await surfaces[0]!.read();
    assert.ok(
      surfaceRead.value.includes(slotArtifactPath(stateDir(ctx), "experiment")),
      "the autostart must reference the promoted artifact",
    );
  } finally {
    await adapter.stop("experiment").catch(() => {});
    await seed.stop();
    await target.stop();
  }
}
