import assert from "node:assert/strict";
import * as path from "node:path";
import { type ToothContext } from "../teeth/registry.ts";
import { PLAIN_DAEMON_SOURCE } from "../../../examples/service-daemon/source.ts";
import { serveRelease } from "./m1.ts";
import { runCommand } from "../artifact-factory/run.ts";
import { processAlive } from "../fake-host/daemon.ts";
import {
  buildServiceDaemon,
  serviceEnv,
  readIncarnation,
  killIncarnation,
  respawnUntilUp,
  seedService,
  waitDead,
  HOST_SHAPES,
  type HostShape,
} from "./m3Hosts.ts";
import { readState } from "./m1.ts";

// ---------------------------------------------------------------------------
// m3.service-upgrade (both host shapes)
// ---------------------------------------------------------------------------

export async function checkM3ServiceUpgrade(
  ctx: ToothContext,
  opts: { serveBadVersion?: boolean } = {},
): Promise<void> {
  for (const shape of HOST_SHAPES) {
    await runUpgradeShape(ctx, shape, opts.serveBadVersion === true);
  }
}

async function runUpgradeShape(
  ctx: ToothContext,
  shape: HostShape,
  serveBadVersion: boolean,
): Promise<void> {
  const shapeCtx: ToothContext = { profile: ctx.profile, sandboxDir: path.join(ctx.sandboxDir, shape) };
  const binPath = await buildServiceDaemon(shapeCtx);
  const seed = await serveRelease(shapeCtx, {
    version: "1.0.0",
    behavior: "ok",
    name: "seed",
    source: PLAIN_DAEMON_SOURCE,
  });
  const target = await serveRelease(shapeCtx, {
    version: "2.0.0",
    behavior: serveBadVersion ? "crash-on-start" : "ok",
    name: "target",
    source: PLAIN_DAEMON_SOURCE,
  });
  const { seedChild, seedPid } = await seedService(shapeCtx, shape, binPath, seed);
  const env = serviceEnv(shapeCtx, shape, target.url, [seed, target]);
  let respawned: Awaited<ReturnType<typeof respawnUntilUp>> | null = null;
  try {
    const before = await readIncarnation(shapeCtx);
    assert.ok(before, "a running incarnation must exist before the upgrade");
    const oldPid = before!.pid;
    const oldStartId = before!.startId;
    assert.ok(processAlive(oldPid), "the pre-upgrade service must be alive");

    const up = await runCommand(binPath, ["self", "upgrade"], { env, timeoutMs: 30000 });
    assert.equal(
      up.code,
      0,
      `self upgrade must exit 0 (${up.stderr.trim()}; serveBadVersion mutation => RED)`,
    );
    if (shape === "respawn") {
      // Tracked, not discarded: if an assertion below fails, an untracked
      // live service keeps the test runner alive and a red degrades into a
      // hang -- the failure mode is then indistinguishable from a wedge.
      respawned = await respawnUntilUp(shapeCtx, env);
    }

    // signal-sent ≠ dead: the OLD pid must be VERIFIED gone.
    assert.ok(!processAlive(oldPid), `[${shape}] the old incarnation must be verified dead`);

    // the new incarnation runs the new version, with a FRESH startId.
    const after = await readIncarnation(shapeCtx);
    assert.ok(after, `[${shape}] a new service must be running after the upgrade`);
    assert.equal(after!.version, "2.0.0", `[${shape}] the running service must be the new version`);
    assert.ok(processAlive(after!.pid), `[${shape}] the new service must be alive`);
    assert.notEqual(
      after!.startId,
      oldStartId,
      `[${shape}] the new incarnation must have a fresh startId (not the old one)`,
    );

    const state = await readState(env);
    assert.equal(state.stableVersion, "2.0.0", `[${shape}] stable slot must hold the new version`);
    assert.equal(state.phase, "promoted", `[${shape}] journal must end at promoted`);
  } finally {
    if (respawned && respawned.child.pid && processAlive(respawned.child.pid)) {
      respawned.child.kill("SIGKILL");
    }
    await killIncarnation(shapeCtx);
    if (processAlive(seedPid)) seedChild.kill("SIGKILL");
    await seed.stop();
    await target.stop();
  }
}

// ---------------------------------------------------------------------------
// m3.service-rollback (both host shapes)
// ---------------------------------------------------------------------------

export async function checkM3ServiceRollback(
  ctx: ToothContext,
  opts: { serveGoodVersion?: boolean } = {},
): Promise<void> {
  for (const shape of HOST_SHAPES) {
    await runRollbackShape(ctx, shape, opts.serveGoodVersion === true);
  }
}

async function runRollbackShape(
  ctx: ToothContext,
  shape: HostShape,
  serveGoodVersion: boolean,
): Promise<void> {
  const shapeCtx: ToothContext = { profile: ctx.profile, sandboxDir: path.join(ctx.sandboxDir, shape) };
  const binPath = await buildServiceDaemon(shapeCtx);
  const seed = await serveRelease(shapeCtx, {
    version: "1.0.0",
    behavior: "ok",
    name: "seed",
    source: PLAIN_DAEMON_SOURCE,
  });
  const target = await serveRelease(shapeCtx, {
    version: "2.0.0",
    behavior: serveGoodVersion ? "ok" : "crash-on-start",
    name: "target",
    source: PLAIN_DAEMON_SOURCE,
  });
  const { seedChild, seedPid } = await seedService(shapeCtx, shape, binPath, seed);
  const env = serviceEnv(shapeCtx, shape, target.url, [seed, target]);
  let respawned: Awaited<ReturnType<typeof respawnUntilUp>> | null = null;
  try {
    const before = await readIncarnation(shapeCtx);
    assert.ok(before, "a running incarnation must exist before the upgrade");
    const oldPid = before!.pid;

    const up = await runCommand(binPath, ["self", "upgrade"], { env, timeoutMs: 30000 });
    if (shape === "respawn") {
      // Tracked, not discarded: if an assertion below fails, an untracked
      // live service keeps the test runner alive and a red degrades into a
      // hang -- the failure mode is then indistinguishable from a wedge.
      respawned = await respawnUntilUp(shapeCtx, env);
    }

    const state = await readState(env);
    if (serveGoodVersion) {
      // mutation: a GOOD version is served — it promotes, so the rollback
      // expectation must go RED
      assert.equal(
        state.phase,
        "rolled-back",
        `[${shape}] a bad version must roll back (good => RED)`,
      );
      return;
    }
    if (shape === "spawn") {
      // the spawn-shape driver survives and returns the outcome itself
      assert.equal(
        up.code,
        1,
        `[${shape}] upgrade to a bad version must exit non-zero (${up.stderr.trim()})`,
      );
    }
    // (the respawn-shape driver exits 0 to request the successor; the
    // outcome is decided by the successor's recovery below)
    assert.equal(state.phase, "rolled-back", `[${shape}] journal must end at rolled-back`);
    assert.equal(state.stableVersion, "1.0.0", `[${shape}] stable slot must hold the old version`);
    assert.equal(state.experimentVersion, null, `[${shape}] experiment slot must be cleared`);

    // The old version must be PULLED BACK AND ACTUALLY RUNNING — verified
    // alive, not just the slots reverted.
    const running = await readIncarnation(shapeCtx);
    assert.ok(running, `[${shape}] a service must be running after the rollback`);
    assert.equal(running!.version, "1.0.0", `[${shape}] the pulled-back service must be the old version`);
    assert.ok(processAlive(running!.pid), `[${shape}] the pulled-back service must be ACTUALLY running`);
    assert.notEqual(
      running!.startId,
      before!.startId,
      `[${shape}] the pulled-back service is a fresh incarnation (new startId)`,
    );
    assert.ok(!processAlive(oldPid), `[${shape}] the pre-upgrade incarnation must stay dead`);
  } finally {
    if (respawned && respawned.child.pid && processAlive(respawned.child.pid)) {
      respawned.child.kill("SIGKILL");
    }
    await killIncarnation(shapeCtx);
    if (processAlive(seedPid)) seedChild.kill("SIGKILL");
    await seed.stop();
    await target.stop();
  }
}

// ---------------------------------------------------------------------------
// m3.stuck-driver-evidence-recovery (respawn shape)
// ---------------------------------------------------------------------------

/**
 * A wedged driver (host.stop() never returns) must not wedge the updater:
 * the host-call budget times the driver out, the upgrade lock is released,
 * the owner respawns the successor, and the successor's recovery decides by
 * EVIDENCE (a live v2 with a fresh startId) — never by a "this restart was
 * planned" flag. `skipRecovery` simulates the must-red mutation (the
 * successor never recovers, so the transaction stays pending).
 */
export async function checkM3StuckDriverEvidence(
  ctx: ToothContext,
  opts: { skipRecovery?: boolean } = {},
): Promise<void> {
  const shape: HostShape = "respawn";
  const shapeCtx: ToothContext = { profile: ctx.profile, sandboxDir: path.join(ctx.sandboxDir, shape) };
  const binPath = await buildServiceDaemon(shapeCtx);
  const seed = await serveRelease(shapeCtx, {
    version: "1.0.0",
    behavior: "ok",
    name: "seed",
    source: PLAIN_DAEMON_SOURCE,
  });
  const target = await serveRelease(shapeCtx, {
    version: "2.0.0",
    behavior: "ok",
    name: "target",
    source: PLAIN_DAEMON_SOURCE,
  });
  const { seedChild, seedPid } = await seedService(shapeCtx, shape, binPath, seed);
  const env = serviceEnv(shapeCtx, shape, target.url, [seed, target]);
  let oldPid: number | null = null;
  try {
    const before = await readIncarnation(shapeCtx);
    assert.ok(before, "a running incarnation must exist before the upgrade");
    oldPid = before!.pid;

    // The driver is wedged at stop(): it must time out (host-call budget),
    // release the lock, and exit — never wedge the tooth.
    const stuckEnv = { ...env, K_STUCK_DRIVER: "1" };
    const up = await runCommand(binPath, ["self", "upgrade"], {
      env: stuckEnv,
      timeoutMs: 30000,
    });
    assert.notEqual(up.code, 0, "the wedged driver must fail (budget timeout), not hang");

    // The owner respawns the successor from the new bytes; its recovery
    // acquires the (released) lock and decides by evidence.
    const respawnEnv = { ...env, ...(opts.skipRecovery === true ? { K_SKIP_RECOVERY: "1" } : {}) };
    const { info: successor, child } = await respawnUntilUp(shapeCtx, respawnEnv);
    try {
      if (opts.skipRecovery) {
        // mutation: the successor never recovers — the transaction stays
        // pending at handing-over, so the promoted assertion goes RED
        const st = await readState(env);
        assert.equal(st.phase, "promoted", "the successor's recovery must finish the transaction (skipRecovery => RED)");
        return;
      }

      // ② the successor is up (respawned from the experiment bytes)
      assert.equal(successor.version, "2.0.0", "the successor must run the new version");
      assert.ok(processAlive(successor.pid), "the successor must be alive");
      assert.notEqual(successor.startId, before!.startId, "the successor is a fresh incarnation");

      // ③ the recovery's judgment matched the evidence (v2 + fresh startId):
      // the transaction reached promoted, so the lock WAS released (the
      // recovery acquired it) and the evidence said handover succeeded.
      const state = await readState(env);
      assert.equal(state.phase, "promoted", "recovery must finish at promoted (evidence, not a flag)");
      assert.equal(state.stableVersion, "2.0.0", "stable must hold the new version");
    } finally {
      if (processAlive(successor.pid)) {
        try {
          process.kill(successor.pid, "SIGKILL");
        } catch {
          // already gone
        }
        await waitDead(successor.pid, 5000);
      }
      void child;
    }
  } finally {
    await killIncarnation(shapeCtx);
    if (oldPid !== null && processAlive(oldPid)) {
      try {
        process.kill(oldPid, "SIGKILL"); // the wedged stop never killed it
      } catch {
        // already gone
      }
    }
    if (processAlive(seedPid)) seedChild.kill("SIGKILL");
    await seed.stop();
    await target.stop();
  }
}
