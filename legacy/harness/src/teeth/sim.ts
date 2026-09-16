/** DST teeth: seeded replay, safety/liveness under faults, and fault-surface coverage. */
import { registerTooth } from "./registry.ts";
import {
  checkFaultSurfaceCovered,
  checkSeedReplayIdentical,
  checkSmokeSeeds,
} from "../sim/checks.ts";

registerTooth({
  id: "sim.seed-replay-identical",
  profiles: ["service"],
  layers: ["L1", "L2"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the scheduler reads ambient entropy or ignores the supplied seed",
      caughtOnlyBy: "this",
    },
  ],
  run: checkSeedReplayIdentical,
});

registerTooth({
  id: "sim.smoke-invariants",
  profiles: ["service"],
  layers: ["L1", "L2"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "journal fsync acknowledges an intent without making it durable",
      caughtOnlyBy: "this",
    },
    {
      mutate: "the host starts experiment without stopping the stable incarnation",
      caughtOnlyBy: {
        alsoCaughtBy: "fake-host no-dual-run scripted tooth",
        whyStillNeeded:
          "the scripted tooth checks one named path; DST checks the property after every seeded effect and recovery interleaving",
      },
    },
    {
      mutate: "terminal recovery leaves hosted work quiesced",
      caughtOnlyBy: "this",
    },
  ],
  run: checkSmokeSeeds,
});

registerTooth({
  id: "sim.fault-surface-covered",
  profiles: ["service"],
  layers: ["L1", "L2"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the fixed corpus silently stops generating one declared fault class",
      caughtOnlyBy: "this",
    },
  ],
  run: checkFaultSurfaceCovered,
});
