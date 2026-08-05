/**
 * Black-box contract teeth — registration site for the --bin mode's
 * fail-closed discipline (harness-design §1.76, xxchan 08-05 ruling: no
 * zero-config defaults, no convention probing — the target MUST be
 * declared). Check bodies live in blackbox.ts.
 */
import { registerTooth } from "./registry.ts";
import { checkMissingTargetFails } from "../targetCheck.ts";

registerTooth({
  id: "blackbox.missing-target-fails",
  profiles: ["swap", "service"],
  layers: ["L0", "L0.5", "L1p"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the harness guesses commands (probes --version / self upgrade) when no target file exists",
      caughtOnlyBy: "this", // only this tooth pins that a missing target is a typed FAIL, never a guess
    },
  ],
  run: checkMissingTargetFails,
});
