/**
 * M1 artifact teeth (test-plan M1 L0 rows; archer's package spec):
 * tampered artifact => refuse install; kill mid-swap => old bytes intact;
 * unknown channel => fail-closed. Registration site only — check bodies
 * live in harness/src/artifact/checks.ts.
 */
import { registerTooth } from "./registry.ts";
import {
  checkTamperedArtifactRefused,
  checkKillMidSwapPreservesOld,
  checkChannelFailClosed,
} from "../artifact/checks.ts";

registerTooth({
  id: "artifact.tamper-refuses-install",
  profiles: ["cli", "daemon", "managed"],
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
  profiles: ["cli", "daemon", "managed"],
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
  id: "artifact.channel-fail-closed",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "resolveSelector falls back when the channel name is not in the manifest",
      caughtOnlyBy: {
        alsoCaughtBy: "core/src/artifact channel unit tests",
        whyStillNeeded:
          "the tooth pins the full resolution path (pinned/alpha/platform semantics), not just the literal parser",
      },
    },
  ],
  run: checkChannelFailClosed,
});
