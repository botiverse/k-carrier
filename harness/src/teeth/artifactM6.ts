/**
 * M6 provenance teeth (test-plan M6 rows: provenance journal forward-only;
 * a genesis machine is NOT_OBSERVED and never counted as "recorded"; an
 * unreadable/corrupt journal is a THIRD state, never genesis; every
 * reconcile that reaches the transaction records WHO drove it, write-ahead).
 * Registration site only — check bodies live in harness/src/artifact/m6.ts.
 */
import { registerTooth } from "./registry.ts";
import {
  checkM6ProvenanceForwardOnly,
  checkM6ProvenanceGenesisNotObserved,
  checkM6ProvenanceRecordsEachReconcile,
} from "../artifact/m6.ts";

registerTooth({
  id: "m6.provenance-forward-only",
  profiles: ["service"],
  layers: ["L5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "an overwrite of an existing entry is accepted (provenance becomes rewritable)",
      caughtOnlyBy: "this", // nobody else pins the forward-only journal
    },
    {
      mutate: "a torn final line is kept (history includes an entry that never completed)",
      caughtOnlyBy: "this",
    },
    {
      mutate: "appends are not unique/ordered (history can be collapsed or reordered)",
      caughtOnlyBy: "this",
    },
    {
      mutate:
        "appending on an unreadable/corrupt history is allowed (a truncated view re-issues a seq)",
      caughtOnlyBy: "this", // the rewrite-under-a-truncated-view attack
    },
  ],
  run: checkM6ProvenanceForwardOnly,
});

registerTooth({
  id: "m6.provenance-genesis-not-observed",
  profiles: ["service"],
  layers: ["L5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate:
        "genesis machines are counted as recorded (recorded ∪ not-observed collapses into one bucket)",
      caughtOnlyBy: "this", // "no data" ≠ "no problem": the M6 genesis guard
    },
    {
      mutate:
        "an empty-but-present journal is reported as genesis (machinery present, misreported as never-had-it)",
      caughtOnlyBy: "this",
    },
    {
      mutate:
        "an unreadable journal is reported as genesis (\"I cannot see the data\" becomes \"there is no data\")",
      caughtOnlyBy: "this", // only this tooth pins the third state
    },
    {
      mutate:
        "aggregation folds unreadable into notObserved (the 'definitely absent' bucket)",
      caughtOnlyBy: "this",
    },
  ],
  run: checkM6ProvenanceGenesisNotObserved,
});

registerTooth({
  id: "m6.provenance-records-each-reconcile",
  profiles: ["service"],
  layers: ["L5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "a successful reconcile leaves no provenance entry (the 'who' is lost)",
      caughtOnlyBy: "this", // only this tooth pins who-drove-it on every reconcile
    },
    {
      mutate:
        "a failed reconcile (auto-rollback) is not recorded (journaling after the outcome, not write-ahead)",
      caughtOnlyBy: "this",
    },
  ],
  run: checkM6ProvenanceRecordsEachReconcile,
});
