/**
 * M1 artifact teeth (test-plan M1 L0 rows; archer's package spec):
 * tampered artifact => refuse install; kill mid-swap => old bytes intact;
 * source refuses rather than guesses. Registration site only — check bodies
 * live in harness/src/artifact/checks.ts.
 */
import { registerTooth } from "./registry.ts";
import {
  checkTamperedArtifactRefused,
  checkKillMidSwapPreservesOld,
  checkSourceFailsClosed,
} from "../artifact/checks.ts";
import {
  checkSwapToolUpgradeLoop,
  checkSwapToolRollback,
} from "../artifact/m1.ts";

registerTooth({
  id: "artifact.tamper-refuses-install",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "downloadVerified skips the sha256 verification",
      caughtOnlyBy: {
        alsoCaughtBy: "core/src/artifact download unit tests (SHA256_MISMATCH)",
        whyStillNeeded:
          "the tooth runs the full black-box plane — fake-server tamper API + factory artifact + real HTTP — which the unit test does not",
      },
    },
  ],
  run: checkTamperedArtifactRefused,
});

registerTooth({
  id: "artifact.atomic-swap-crash-safe",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "atomicWriteFile writes the target in place (no tmp+rename; half-writes visible)",
      caughtOnlyBy: "this", // only this tooth kills a real process mid-swap
    },
  ],
  run: checkKillMidSwapPreservesOld,
});

registerTooth({
  id: "artifact.source-fails-closed",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the release source guesses a target instead of refusing (unknown platform / unservable version)",
      caughtOnlyBy: {
        alsoCaughtBy: "core/src/artifact source unit tests",
        whyStillNeeded:
          "the tooth pins refusal at the real source boundary (platform + named-version), not just one helper",
      },
    },
  ],
  run: checkSourceFailsClosed,
});

registerTooth({
  id: "m1.swap-tool-upgrade",
  profiles: ["swap"],
  layers: ["L0", "L0.5", "L1p"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the upgrade never reaches the stable slot (next run still reports the old version)",
      caughtOnlyBy: "this", // only this tooth runs the full black-box upgrade through the demo
    },
  ],
  run: checkSwapToolUpgradeLoop,
});

registerTooth({
  id: "m1.swap-tool-rollback",
  profiles: ["swap"],
  layers: ["L0", "L0.5", "L1p"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "a failing experiment is promoted instead of rolled back",
      caughtOnlyBy: {
        alsoCaughtBy: "core txn engine unit tests (rollback symmetry)",
        whyStillNeeded:
          "the engine tests use in-memory effects; this tooth drives the real binary + real slots through the demo's own upgrade command",
      },
    },
  ],
  run: checkSwapToolRollback,
});
