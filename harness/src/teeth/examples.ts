/**
 * Examples teeth — each demo is the credential for its profile's support
 * claim (examples/README.md). Registration site only; check bodies live in
 * harness/src/examples/checks.ts.
 */
import { registerTooth } from "./registry.ts";
import {
  checkCliToolBlackbox,
  checkPlainDaemonContract,
  checkManagedHostAdapter,
} from "../examples/checks.ts";

registerTooth({
  id: "examples.cli-tool-blackbox",
  profiles: ["cli"],
  layers: ["L0", "L0.5", "L1p"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "self upgrade swaps no bytes (serves the current version's artifact)",
      caughtOnlyBy: {
        alsoCaughtBy: "k-harness --bin contract.self-upgrade (CONTRACT_UPGRADE_SELF_UNCHANGED)",
        whyStillNeeded:
          "this tooth makes the cli-tool demo's claim a CI-enforced registered tooth in the cli tier, not just an ad-hoc CLI invocation",
      },
    },
  ],
  run: checkCliToolBlackbox,
});

registerTooth({
  id: "examples.plain-daemon-contract",
  profiles: ["daemon"],
  layers: ["L0", "L0.5", "L2", "L3"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the daemon crashes on start (or never answers the probe)",
      caughtOnlyBy: "this", // only this tooth exercises the daemon demo in process reality
    },
  ],
  run: checkPlainDaemonContract,
});

registerTooth({
  id: "examples.managed-host-adapter",
  profiles: ["managed"],
  layers: ["L2", "L3"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the managed host loses the session ledger on resume",
      caughtOnlyBy: "this", // only this tooth pins the managed demo's session preservation
    },
  ],
  run: checkManagedHostAdapter,
});
