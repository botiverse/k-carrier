/**
 * adapter.service-probe-* — the evidence checks, for a REAL adopter host.
 *
 * These exist because the contract-subset versions in fake-host/checks.ts are
 * written against the in-process fake host: they call `start("stable")` on a
 * host that invents its slots, and they were gated on the adapter declaring a
 * workload driver (doWork/ledger) — a marker with nothing to do with what they
 * assert. The effect was an inverted incentive: raft-computer honestly declines
 * to claim session continuity, so it lost the two checks that most directly pin
 * its evidence mapping. An adopter should be checked on what it claims to do,
 * never checked LESS for declining to claim something.
 *
 * So the property is re-asserted here against real slots, seeded by a real
 * upgrade, and gated on being a service host — which is what it actually needs.
 */
import assert from "node:assert/strict";
import { type ToothContext } from "../teeth/registry.ts";
import { serveRelease } from "../artifact/m1.ts";
import { processAlive } from "../fake-host/daemon.ts";
import {
  makeUpgrader,
  releaseSourceFor,
  stateDir,
  type ServiceAdapterFactory,
} from "./serviceChecks.ts";

/**
 * The probe must describe the process that is running NOW.
 *
 * Seeded by a real upgrade, then the live incarnation is SIGKILLed behind the
 * adapter's back. A probe that reads a cached value, a version file, or a
 * pidfile it never cross-checks will happily keep reporting the dead
 * incarnation's evidence — and every convergence predicate built on it becomes
 * a statement about a process that no longer exists.
 *
 * That is the un-fakeable part: after the kill there is nothing truthful to
 * say, so the only correct behaviours are to throw or to report a DIFFERENT
 * live process. Returning the old evidence is the failure.
 */
export async function checkAdapterProbeBindsLiveProcess(
  ctx: ToothContext,
  adapterFactory: ServiceAdapterFactory,
  mutate?: { skipKill?: boolean },
): Promise<void> {
  const adapter = adapterFactory(stateDir(ctx));
  const seed = await serveRelease(ctx, {
    version: "1.0.0",
    behavior: "ok",
    name: "adapter-probe",
    source: releaseSourceFor(adapter),
  });
  try {
    const outcome = await makeUpgrader(ctx, adapter, seed.url).upgrade();
    assert.equal(outcome.result, "promoted", `seed upgrade must promote (${outcome.result})`);

    const live = await adapter.healthProbe();
    assert.equal(live.version, "1.0.0", "probe must report the running slot's version");
    assert.ok(processAlive(live.pid), "probe must report a pid that is actually alive");
    assert.ok(live.startId, "probe must report a startId");

    // mutation: leave the incarnation alive — the assertion below must then
    // fail, which is what proves the kill (not some unrelated flakiness) is
    // what makes the probe stop answering.
    if (mutate?.skipKill !== true) {
      process.kill(live.pid, "SIGKILL");
      const deadline = Date.now() + 5_000;
      while (processAlive(live.pid) && Date.now() < deadline) {
        await new Promise((r) => { setTimeout(r, 25); });
      }
      assert.ok(!processAlive(live.pid), "the incarnation must actually be dead before probing again");
    }

    let stale: { version: string; pid: number; startId: string } | null = null;
    try {
      stale = await adapter.healthProbe();
    } catch {
      return; // refused to answer: correct — nothing is running
    }
    assert.notEqual(
      stale.startId,
      live.startId,
      "probe returned the DEAD incarnation's evidence — it is reading a cache, " +
        "a file, or a pid it never verified, not the live process",
    );
    assert.ok(
      processAlive(stale.pid),
      "probe reported a pid that is not alive; evidence must come from a running process",
    );
  } finally {
    await adapter.stop("experiment").catch(() => {});
    await seed.stop();
  }
}
