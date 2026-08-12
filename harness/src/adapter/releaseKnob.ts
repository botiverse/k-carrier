/**
 * adapter.service-release-knob-bites — prove the ADOPTER'S negative controls are real
 * before any check that depends on them is believed.
 *
 * Split out from serviceChecks.ts because it is a different subject: those
 * check the upgrade, this one checks that the way we make an upgrade fail
 * actually makes it fail.
 */
import assert from "node:assert/strict";
import { type ToothContext } from "../teeth/registry.ts";
import { serveRelease } from "../artifact/m1.ts";
import { PLAIN_DAEMON_SOURCE } from "../../../examples/service-daemon/source.ts";
import {
  makeUpgrader,
  releaseSourceFor,
  stateDir,
  type ServiceAdapterFactory,
} from "./serviceChecks.ts";

/**
 * Prove the adopter's release source honours `__K_BEHAVIOR__` before any tooth
 * relies on it.
 *
 * Every negative control here serves a `crash-on-start` release and expects the
 * upgrade to roll back. If the adopter's source ignores the knob, the "bad"
 * release comes up healthy, the upgrade promotes, and the mutation the tooth
 * declares it would catch quietly stops being a mutation at all -- the tooth
 * passes identically whether or not the property holds. A positive control that
 * cannot be shown to fire is not a control.
 *
 * Adopters on the demo daemon are exempt: the demo's knob is pinned by its own
 * teeth, so re-proving it here would only re-test the harness.
 */
export async function checkAdapterReleaseKnob(
  ctx: ToothContext,
  adapterFactory: ServiceAdapterFactory,
  mutate?: { ignoreKnob?: boolean },
): Promise<void> {
  const adapter = adapterFactory(stateDir(ctx));
  const source = releaseSourceFor(adapter);
  if (source === PLAIN_DAEMON_SOURCE) return;

  const bad = await serveRelease(ctx, {
    version: "2.0.0",
    // mutation: build a healthy release while calling it bad — this is what an
    // adopter who ignores the knob effectively does.
    behavior: mutate?.ignoreKnob === true ? "ok" : "crash-on-start",
    name: "adapter-knob",
    source,
  });
  try {
    const up = makeUpgrader(ctx, adapter, bad.url);
    const outcome = await up.upgrade();
    assert.notEqual(
      outcome.result,
      "promoted",
      "a crash-on-start release of the adopter's app must NOT promote — " +
        "if it does, the source ignores __K_BEHAVIOR__ and every negative " +
        "control in adapter mode is a no-op",
    );
  } finally {
    await adapter.stop("experiment").catch(() => {});
    await bad.stop();
  }
}
