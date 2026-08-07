/**
 * M1 download-hole teeth (archer's 8 L0 fixes, one tooth per hole:
 * deadline raced not signalled, Rosetta arch lie, progress without
 * resumeDir, empty body named, stall bounds silence, error classification,
 * stall phase honesty). Registration site only — check bodies live in
 * harness/src/artifact/downloadHoles.ts.
 */
import { registerTooth } from "./registry.ts";
import {
  checkDownloadTimeoutEnforced,
  checkPlatformKeyNativeArch,
  checkDownloadProgressWithoutResumeDir,
  checkDownloadEmptyBodyNamed,
  checkDownloadStallBoundsSilence,
  checkDownloadErrorsClassified,
  checkDownloadStallPhaseHonest,
} from "../artifact/downloadHoles.ts";

registerTooth({
  id: "m1.download-timeout-enforced",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "the deadline is only signalled, never raced — a fetch that ignores AbortSignal outlives every timeout (all timeouts silently inert)",
      caughtOnlyBy: "this", // fetchImpl is an adopter-supplied seam; its regression looks exactly like a working download
    },
  ],
  run: checkDownloadTimeoutEnforced,
});

registerTooth({
  id: "m1.platform-key-native-arch",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "the platform key trusts process.arch — under Rosetta the machine is pinned to the x64 build forever, with nothing looking wrong",
      caughtOnlyBy: "this", // the wrong package is still a fully legal package: no error, just the wrong hardware served
    },
    {
      mutate:
        "the hardware probe is consulted outside darwin+x64 (shelling out on every platform lookup)",
      caughtOnlyBy: "this",
    },
  ],
  run: checkPlatformKeyNativeArch,
});

registerTooth({
  id: "m1.download-progress-without-resumedir",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "byte progress never fires without a resumeDir (a configured-looking sink that never moves)",
      caughtOnlyBy: "this", // "slow" vs "hung" must stay distinguishable even with no partial to resume
    },
  ],
  run: checkDownloadProgressWithoutResumeDir,
});

registerTooth({
  id: "m1.download-empty-body-named",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "a no-body response returns zero bytes — the only symptom is a sha256 mismatch against the empty string, hiding the cause",
      caughtOnlyBy: "this", // the failure path must not produce the empty success value
    },
  ],
  run: checkDownloadEmptyBodyNamed,
});

registerTooth({
  id: "m1.download-stall-bounds-silence",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "the stall budget is a total timeout — a slow-but-progressing download is killed (silence and duration conflated)",
      caughtOnlyBy: "this", // bounding SILENCE follows liveness; a total budget encodes a guess about size/bandwidth
    },
    {
      mutate: "there is no stall budget at all — a wedged connection holds until the total timeout and never names the stall",
      caughtOnlyBy: "this",
    },
  ],
  run: checkDownloadStallBoundsSilence,
});

registerTooth({
  id: "m1.download-errors-classified",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "an in-memory download error is reported bare — an abort we caused ourselves is indistinguishable from the network breaking",
      caughtOnlyBy: "this", // "we gave up on purpose" must be tellable from "the network died"
    },
  ],
  run: checkDownloadErrorsClassified,
});

registerTooth({
  id: "m1.download-stall-phase-honest",
  profiles: ["swap", "service"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "a stall that happened mid-body is reported as 'awaiting response' — the reader looks at the wrong end of the transfer",
      caughtOnlyBy: "this",
    },
  ],
  run: checkDownloadStallPhaseHonest,
});
