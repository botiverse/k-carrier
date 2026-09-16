/**
 * fake-host teeth (harness-design §1.1 first half; the package spec:
 * ledger equivalence incl. after rollback, and every fault switch really
 * turning its tooth red — switch off, tooth green).
 *
 * Registration site only — check bodies live in fake-host/checks.ts;
 * importing this module registers the teeth.
 */
import { registerTooth } from "./registry.ts";
import {
  checkLedgerEquivalence,
  checkLedgerEquivalenceAfterRollback,
  checkQuiesceCompletes,
  checkStopCompletes,
  checkProbeVersionMatchesSlot,
  checkProbeBindsCurrentIncarnation,
  checkStartCompletes,
} from "../fake-host/checks.ts";

registerTooth({
  id: "fake-host.ledger-equivalence",
  profiles: ["service"],
  layers: ["L2"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "resume() rewrites the ledger differently than quiesce parked",
      caughtOnlyBy: "this", // only this tooth compares parked vs resumed bytes on the direct path
    },
    {
      mutate: "quiesce() does not durably park the workload (ledger lost)",
      caughtOnlyBy: "this",
    },
  ],
  run: checkLedgerEquivalence,
});

registerTooth({
  id: "fake-host.ledger-equivalence-after-rollback",
  profiles: ["service"],
  layers: ["L2"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "resume() after rollback restores a different ledger",
      caughtOnlyBy: "this", // the rollback path is only exercised by this tooth
    },
  ],
  run: checkLedgerEquivalenceAfterRollback,
});

registerTooth({
  id: "fake-host.fault-fail-on-quiesce",
  profiles: ["service"],
  layers: ["L2"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "quiesce() fails to park even when fail-on-quiesce is off",
      caughtOnlyBy: "this", // only this tooth pins quiesce's normal completion
    },
  ],
  run: checkQuiesceCompletes,
});

registerTooth({
  id: "fake-host.fault-hang-on-stop",
  profiles: ["service"],
  layers: ["L2"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "stop() never completes even when hang-on-stop is off",
      caughtOnlyBy: "this", // only this tooth races stop against a clock window
    },
  ],
  run: checkStopCompletes,
});

registerTooth({
  id: "fake-host.fault-wrong-version-probe",
  profiles: ["service"],
  layers: ["L2", "L3"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "healthProbe() reports a wrong version even when the switch is off",
      caughtOnlyBy: "this", // probe veracity per slot is pinned only here
    },
  ],
  run: checkProbeVersionMatchesSlot,
});

registerTooth({
  id: "fake-host.fault-stale-startid-probe",
  profiles: ["service"],
  layers: ["L2", "L3"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "healthProbe() reports a stale startId even when the switch is off",
      caughtOnlyBy: "this", // incarnation binding is pinned only here
    },
  ],
  run: checkProbeBindsCurrentIncarnation,
});

registerTooth({
  id: "fake-host.fault-crash-during-start",
  profiles: ["service"],
  layers: ["L2"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "start() throws even when crash-during-start is off",
      caughtOnlyBy: "this", // only this tooth pins start's normal completion
    },
  ],
  run: checkStartCompletes,
});
