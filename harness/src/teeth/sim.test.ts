// @invariant — DST is replayable, its fixed corpus really covers every
// declared fault class, and its must-red mutations are observed as failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSimulation } from "../sim/run.ts";
import { allTeeth } from "./registry.ts";
import "./sim.ts";

const SIM_TOOTH_IDS = new Set([
  "sim.seed-replay-identical",
  "sim.smoke-invariants",
  "sim.fault-surface-covered",
]);

test("known-green: every registered DST tooth passes", async () => {
  const teeth = allTeeth().filter((tooth) => SIM_TOOTH_IDS.has(tooth.id));
  assert.equal(teeth.length, SIM_TOOTH_IDS.size);
  for (const tooth of teeth) await tooth.run({ profile: "service", sandboxDir: "" });
});

test("known-red: losing journal durability is caught", async () => {
  const result = await runSimulation(7, { mutation: "drop-journal-durability", faults: false });
  assert.equal(result.status, "fail");
  assert.match(result.failure!, /k\.journal-precedes-phase/);
});

test("known-red: starting experiment beside stable is caught", async () => {
  const result = await runSimulation(11, { mutation: "skip-stable-stop", faults: false });
  assert.equal(result.status, "fail");
  assert.match(result.failure!, /k\.never-dual-run/);
});

test("known-red: a terminal transaction that never resumes work is caught", async () => {
  const result = await runSimulation(17, { mutation: "skip-terminal-resume", faults: false });
  assert.equal(result.status, "fail");
  assert.match(result.failure!, /workloads quiesced/);
});

test("failure output carries the exact one-command replay key", async () => {
  const result = await runSimulation(7, { mutation: "drop-journal-durability", faults: false });
  assert.equal(result.replay, "k-harness sim --seed 7 --json");
  assert.equal(result.seed, 7);
  assert.match(result.transcriptSha256, /^[a-f0-9]{64}$/);
});
