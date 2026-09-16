// @invariant — runner fail-closed: an empty teeth selection is a typed
// FAIL with a non-zero signal, never a green receipt. (runner.ts no
// longer imports the registration index — the CLI entry does — so this
// file can exercise the empty-registry path directly.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfile } from "./runner.ts";

test("an empty teeth selection is a typed FAIL, not a pass", async () => {
  // nothing has registered teeth in this process yet
  const r = await runProfile("swap");
  assert.equal(r.result, "fail");
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0]!.id, "harness.empty-selection");
  assert.equal(r.checks[0]!.status, "fail");
  assert.match(r.checks[0]!.error!, /HARNESS_EMPTY_SELECTION.*profile swap/);
});

test("with teeth registered, profile mode runs them and passes", async () => {
  await import("./teeth/index.ts"); // registers all teeth (side effect)
  const r = await runProfile("swap");
  assert.equal(r.result, "pass");
  assert.ok(r.checks.length > 0, "cli tier must have teeth");
});
