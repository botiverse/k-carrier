// @invariant — harness self-check teeth: every profile tier must contain
// real teeth; an emptied tier (or one left with only self-check teeth)
// must go RED.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth (incl. selfCheck)
import {
  allTeeth,
  clearRegistry,
  registerTooth,
  teethFor,
  type ToothContext,
  type ToothSpec,
} from "./registry.ts";
import { checkTierHasTeeth } from "./selfCheck.ts";

const SELF_CHECK_IDS = ["harness.teeth-present-cli", "harness.teeth-present-daemon", "harness.teeth-present-managed"];

const ctx: ToothContext = { profile: "managed", sandboxDir: "" };

test("known-green: each profile tier has real teeth, self-check teeth pass", async () => {
  const teeth = allTeeth().filter((t) => SELF_CHECK_IDS.includes(t.id));
  assert.equal(teeth.length, 3, "all three self-check teeth must be registered");
  for (const tooth of teeth) {
    await tooth.run(ctx); // must not throw
    assert.equal(tooth.profiles.length, 1, `${tooth.id}: exactly one profile`);
    assert.equal(tooth.kind.kind, "invariant");
    assert.ok(tooth.mustRed.length > 0, `${tooth.id}: must-red`);
  }
  // and each tier genuinely has real (non-harness) teeth
  for (const profile of ["cli", "daemon", "managed"] as const) {
    assert.ok(
      teethFor(profile).some((t) => !t.id.startsWith("harness.")),
      `${profile} tier must contain real teeth`,
    );
  }
});

test("known-red: an emptied tier makes the self-check red", async () => {
  clearRegistry();
  await assert.rejects(checkTierHasTeeth("cli"), /HARNESS_EMPTY_TIER/);
});

test("known-red: a tier left with only self-check teeth is still red", async () => {
  clearRegistry();
  const spec: ToothSpec = {
    id: "harness.teeth-present-cli",
    profiles: ["cli"],
    layers: ["L0"],
    kind: { kind: "invariant" },
    mustRed: [{ mutate: "x", caughtOnlyBy: "this" }],
    run: async () => {},
  };
  registerTooth(spec);
  await assert.rejects(checkTierHasTeeth("cli"), /HARNESS_EMPTY_TIER/);
});
