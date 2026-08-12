// @invariant — these lock the registry's discipline rules themselves (the
// rules ARE the product of this module; they should never regress).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerTooth,
  teethFor,
  exportForMutationRunner,
  clearRegistry,
  ToothRegistrationError,
  type ToothSpec,
} from "./registry.ts";

function validSpec(overrides: Partial<ToothSpec> = {}): ToothSpec {
  return {
    id: "txn.no-dual-run",
    profiles: ["service"],
    layers: ["L1", "L2"],
    kind: { kind: "invariant" },
    mustRed: [{ mutate: "skip journal fsync before handover", caughtOnlyBy: "this" }],
    run: async () => {},
    ...overrides,
  };
}

beforeEach(() => clearRegistry());

test("registers a fully-declared tooth and tier-filters it", () => {
  registerTooth(validSpec());
  assert.equal(teethFor("service").length, 1);
  assert.equal(teethFor("service").length, 1);
  assert.equal(teethFor("swap").length, 0);
});

function assertRejects(spec: ToothSpec, code: string) {
  try {
    registerTooth(spec);
  } catch (err) {
    assert.ok(err instanceof ToothRegistrationError, `expected ToothRegistrationError, got ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected registration to fail with ${code}`);
}

test("rejects malformed and duplicate ids", () => {
  assertRejects(validSpec({ id: "" }), "BAD_ID");
  assertRejects(validSpec({ id: "Bad_ID!" }), "BAD_ID");
  registerTooth(validSpec());
  assertRejects(validSpec(), "DUPLICATE_ID");
});

test("rejects a tooth with no profiles or no layers", () => {
  assertRejects(validSpec({ profiles: [] }), "NO_PROFILES");
  assertRejects(validSpec({ layers: [] }), "NO_LAYERS");
});

test("rejects a baseline tooth without a failure condition", () => {
  assertRejects(
    validSpec({ kind: { kind: "baseline", failureCondition: "  " } }),
    "BASELINE_WITHOUT_FAILURE_CONDITION",
  );
  // with a stated failure condition it is accepted
  registerTooth(
    validSpec({
      kind: {
        kind: "baseline",
        failureCondition: "goes RED when in-place convergence is wired; replaced by entry-family tooth",
      },
    }),
  );
});

test("rejects an empty or unanswered must-red list", () => {
  assertRejects(validSpec({ mustRed: [] }), "NO_MUST_RED");
  assertRejects(
    validSpec({ mustRed: [{ mutate: "   ", caughtOnlyBy: "this" }] }),
    "MUST_RED_UNANSWERED",
  );
  assertRejects(
    validSpec({
      mustRed: [
        { mutate: "drop sig verify", caughtOnlyBy: { alsoCaughtBy: "typecheck", whyStillNeeded: " " } },
      ],
    }),
    "MUST_RED_UNANSWERED",
  );
});

test("tier boundary: a cli-tagged tooth exercising L2 is rejected at registration", () => {
  assertRejects(
    validSpec({ id: "bad.cli-tooth", profiles: ["swap"], layers: ["L0", "L2"] }),
    "TIER_BOUNDARY",
  );
  // cli-tagged tooth within cli layers is fine
  registerTooth(
    validSpec({ id: "ok.cli-tooth", profiles: ["swap"], layers: ["L0", "L1p"] }),
  );
  assert.equal(teethFor("swap").length, 1);
});

test("mutation-runner export carries every tooth's must-red list", () => {
  registerTooth(validSpec());
  registerTooth(
    validSpec({
      id: "converge.projection-ban",
      profiles: ["service"],
      layers: ["L3"],
      mustRed: [
        { mutate: "let manifest version green the predicate", caughtOnlyBy: "this" },
        {
          mutate: "read version from state file instead of live process",
          caughtOnlyBy: { alsoCaughtBy: "probe-liveness tooth", whyStillNeeded: "this one pins the predicate source, that one pins pid binding" },
        },
      ],
    }),
  );
  const exported = exportForMutationRunner();
  assert.equal(exported.length, 2);
  const byId = new Map(exported.map((e) => [e.id, e]));
  assert.equal(byId.get("converge.projection-ban")!.mustRed.length, 2);
});
