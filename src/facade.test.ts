// @baseline The default entry remains a usable Promise-only adapter surface.
import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  Artifact,
  JournalEntry,
  ProcessEvidence,
  Slot,
} from "./domain.ts";
import { createPromiseKernel } from "./facade.ts";

it("runs the durable protocol through the Promise facade", async () => {
  const journal: Array<JournalEntry> = [];
  let stable: Artifact = { version: "1.0.0", digest: "stable" };
  let experiment: Artifact | null = null;
  let running: Slot | null = "stable";
  let evidence: ProcessEvidence | null = {
    version: "1.0.0",
    startId: "start-1",
  };
  let counter = 1;
  let locked = false;
  const completed = new Set<string>();

  const kernel = createPromiseKernel({
    clock: {
      now: async () => 1_700_000_000_000 + journal.length,
    },
    journal: {
      read: async () => journal,
      appendAndSync: async (entry) => {
        journal.push(entry);
      },
    },
    slots: {
      stable: async () => stable,
      experiment: async () => experiment,
      stage: async (artifact) => {
        experiment = artifact;
      },
      promote: async () => {
        if (experiment !== null) stable = experiment;
        experiment = null;
        if (running === "experiment") running = "stable";
      },
      clearExperiment: async () => {
        experiment = null;
      },
    },
    source: {
      resolve: async (version) => ({ version, digest: `digest:${version}` }),
    },
    host: {
      quiesce: async (mutation) => {
        completed.add(mutation.actionId);
        return "done";
      },
      stop: async (slot, mutation) => {
        if (!completed.has(mutation.actionId) && running === slot) {
          running = null;
          evidence = null;
        }
        completed.add(mutation.actionId);
        return "done";
      },
      start: async (slot, mutation) => {
        if (!completed.has(mutation.actionId)) {
          const artifact = slot === "stable" ? stable : experiment;
          assert.notEqual(artifact, null);
          counter += 1;
          running = slot;
          evidence = {
            version: artifact?.version ?? "invalid",
            startId: `start-${counter}`,
          };
        }
        completed.add(mutation.actionId);
        return "done";
      },
      resume: async (mutation) => {
        completed.add(mutation.actionId);
        return "done";
      },
      probe: async () =>
        evidence === null
          ? { _tag: "Unknown" }
          : { _tag: "Observed", evidence },
    },
    verify: async (observed, target) => observed.version === target.version,
    lock: {
      acquire: async () => {
        if (locked) throw new Error("locked");
        locked = true;
        return async () => {
          locked = false;
        };
      },
    },
  });

  const outcome = await kernel.upgrade({
    operationId: "promise-1",
    targetVersion: "2.0.0",
  });
  await kernel.close();

  assert.equal(outcome._tag, "Promoted");
  assert.equal(stable.version, "2.0.0");
  assert.equal(running, "stable");
  assert.equal(journal.at(-1)?.phase, "committed");
  assert.equal(locked, false);
});
