/**
 * artifact-factory teeth (harness-design §1.77; archer's package spec:
 * determinism + the ok artifact really runs and reports its version).
 *
 * Registration site only — check bodies live in
 * artifact-factory/checks.ts; importing this module registers the teeth.
 */
import { registerTooth } from "./registry.ts";
import { checkDeterministicBuild, checkOkArtifactRuns } from "../artifact-factory/checks.ts";

registerTooth({
  id: "artifact-factory.deterministic-build",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "stamp embeds a time-varying byte (e.g. a build timestamp)",
      caughtOnlyBy: "this", // only this tooth compares two fresh builds byte-for-byte
    },
  ],
  run: checkDeterministicBuild,
});

registerTooth({
  id: "artifact-factory.ok-artifact-runs",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "stamp embeds the wrong version string",
      caughtOnlyBy: "this", // determinism tooth still passes (wrong is consistent); only a real run exposes it
    },
    {
      mutate: "the ok artifact exits non-zero on start",
      caughtOnlyBy: "this", // only this tooth executes the built binary
    },
  ],
  run: checkOkArtifactRuns,
});
