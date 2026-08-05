/**
 * Harness self-check teeth — the tier lower-bound (archer's review fix:
 * "零齿 = 假绿"). Each profile's tier must contain real (non-harness)
 * teeth; a broken tier filter that empties a tier must go RED.
 *
 * Two layers of fail-closed protection:
 *  1. runner.ts: a profile/adapter selection of ZERO checks is a typed
 *     HARNESS_EMPTY_SELECTION FAIL (an empty receipt is never green);
 *  2. these teeth: a tier that keeps only the harness self-check teeth
 *     (non-empty receipt, but no real teeth) also goes RED.
 */
import assert from "node:assert/strict";
import { registerTooth, teethFor, type Profile } from "./registry.ts";

const HARNESS_PREFIX = "harness.";

/** A profile tier must contain at least one real (non-self-check) tooth. */
export async function checkTierHasTeeth(profile: Profile): Promise<void> {
  const selected = teethFor(profile);
  const real = selected.filter((t) => !t.id.startsWith(HARNESS_PREFIX));
  assert.ok(
    real.length > 0,
    `HARNESS_EMPTY_TIER: profile ${profile} has ${selected.length} teeth, ${real.length} non-harness (tier filter likely emptied it)`,
  );
}

for (const profile of ["swap", "service", "hosted"] as const) {
  registerTooth({
    id: `harness.teeth-present-${profile}`,
    profiles: [profile],
    layers: ["L0"],
    kind: { kind: "invariant" },
    mustRed: [
      {
        mutate: `the tier filter drops every non-harness tooth from the ${profile} tier`,
        caughtOnlyBy: {
          alsoCaughtBy: "harness.empty-selection fail-closed (only when zero teeth remain at all)",
          whyStillNeeded:
            "empty-selection catches total emptiness; this tooth catches a tier that keeps the self-check teeth but loses the real ones — a non-empty receipt that would still be a false green",
        },
      },
    ],
    run: () => checkTierHasTeeth(profile),
  });
}
