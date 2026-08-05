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
import {
  checkM2UntrustedSignerRefused,
  checkM2TamperedArtifactRefused,
  checkM2UnsignedExplicitAccepted,
  checkM2UnsignedRefusedByDefault,
} from "../artifact/m2.ts";

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

registerTooth({
  id: "m2.untrusted-signer-refused",
  profiles: ["swap"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "verifyChain accepts any self-consistent signature chain (no root endorsement needed)",
      caughtOnlyBy: {
        alsoCaughtBy: "core/src/distsign verify unit tests (SIGNING_KEY_NOT_ROOT_SIGNED)",
        whyStillNeeded:
          "the unit tests use in-memory keys; this tooth runs the full black-box plane — a compromised publisher's release through the real demo upgrade",
      },
    },
  ],
  run: checkM2UntrustedSignerRefused,
});

registerTooth({
  id: "m2.tampered-artifact-refused",
  profiles: ["swap"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the signature check is skipped when the digest matches (authenticity degenerates to integrity)",
      caughtOnlyBy: {
        alsoCaughtBy: "core/src/distsign verify unit tests (ARTIFACT_SIGNATURE_INVALID)",
        whyStillNeeded:
          "this tooth constructs the consistent-digest attack end to end (tamper + re-manifest over the real server)",
      },
    },
  ],
  run: checkM2TamperedArtifactRefused,
});

registerTooth({
  id: "m2.unsigned-explicit-accepted",
  profiles: ["swap"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "an absent signature is silently treated as unsigned (no recorded opt-out)",
      caughtOnlyBy: "this", // only this tooth pins that unsigned must be explicit AND recorded
    },
  ],
  run: checkM2UnsignedExplicitAccepted,
});

registerTooth({
  id: "m2.unsigned-refused-by-default",
  profiles: ["swap"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "a release source is allowed to declare its own bytes acceptable (manifest-declared unsigned, or an allowUnsigned option on the source)",
      caughtOnlyBy: {
        alsoCaughtBy: "core/src/artifact/sourceTrust.test.ts (same attack, in-process)",
        whyStillNeeded:
          "this runs it against the real publisher and a real binary: the client's compiled-in root keys are present and correct, and the payload still must not install",
      },
    },
  ],
  run: checkM2UnsignedRefusedByDefault,
});
