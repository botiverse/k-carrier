# Formal model of the K two-slot upgrade transaction (Lean 4)

`Protocol.lean` is a Lean 4 model of the transaction engine with
machine-checked proofs of three properties over every reachable state:

| Property (named after `core/src/invariants.ts`) | Lean theorem |
|---|---|
| `k.never-dual-run` — a stable and an experiment incarnation are never live at once | `never_dual_run` |
| `k.never-bricked` — the stable slot always holds usable bytes | `never_bricked` |
| journal write-ahead — a live experiment implies a durable handing-over intent; experiment bytes imply a durable staged intent | `write_ahead` |

All three together: `protocol_guarantees`.

## What the model is

- `Phase` is the seven-phase `TxnPhase` from `core/src/txn/state.ts`.
- Intent steps are the edges of `core/src/txn/transitions.ts::TRANSITIONS`,
  including the rollback edge from every in-flight phase.
- Effect steps are the host and slot calls the engine issues after each
  journaled intent (`core/src/txn/engine.ts`): stage bytes, stop stable,
  start experiment, promote, stop experiment, start stable, clear experiment.
  One step per call, so a crash can fall between any two of them.
- Crash and recovery are not special steps. A crash loses nothing durable,
  and recovery only ever journals a rollback intent from an in-flight phase
  or replays the effects of the last intent. Both are ordinary steps of the
  relation, so every instant the crash matrix enumerates
  (`harness/src/crash/enumerate.ts`: before-journal, after-journal,
  after-action) is a reachable state the theorems cover.
- Reachability is an inductive relation from the initial machine; the proofs
  are by induction on it with one inductive invariant (`Safe`).

`never_dual_run` is the theorem with content. It holds because every step
that starts a process is guarded by the stop it must follow, on the handover
path, the rollback path and the recovery replay path. Remove a guard and the
proof fails. `never_bricked` records that no step in the relation clears the
stable slot; promote replaces it with the verified candidate.

Three `example`s at the end of the file exhibit reachable states with a live
experiment, a completed promotion and a completed rollback. They exist so the
guards cannot quietly make the interesting states unreachable, which would
make the theorems vacuous.

## What the model does not say

- **Host honesty.** The model assumes what the HostAdapter contract demands:
  `stop()` returning means the process is gone, `start()` starts only the
  requested slot, the probe answers for one live incarnation. A controller
  that returns from `stop` without stopping violates the assumption, and no
  theorem here constrains it. The engine's own defence against a lying probe
  (the pre-handover `startId` is journaled and a readback that repeats it is
  refused) is below the model's granularity.
- **Filesystem durability.** Promote is one effect step. In code it is two
  renames; the window between them is covered by the durable promote intent
  and idempotent replay, not by this model.
- **Liveness.** Nothing here says an upgrade finishes; `core/src/liveness.ts`
  and the harness judge that.

## Reproduce

Requires [elan](https://github.com/leanprover/elan).

```sh
elan run leanprover/lean4:stable lean formal/Protocol.lean
# exits 0 with only linter warnings when the proofs hold
```

The invariant is named `Safe` because `Inv` is taken by Lean's core library.
Proofs use `theorem`, not `lemma`: `lemma` after a multi-clause `def` or
`inductive` trips a parser quirk on some releases.

## Keeping the model in step with the code

There is no automatic TypeScript to Lean extraction; the model stays a
truthful projection by discipline. When `TxnPhase`, `TRANSITIONS` or the
engine's call order change, change `Phase`, `Step` and this README in the
same commit. The generated crash matrix and seeded simulation in `harness/`
test the real engine against the same properties, which is what binds "what
the model proves" to "what the code does".
