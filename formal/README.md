# Formal model of the K two-slot upgrade core (Lean 4)

This directory holds a **machine-checked** Lean 4 model of k-carrier's two-slot
upgrade transaction core, with proofs of the protocol's headline invariants:

| Invariant (mirrors `core/src/invariants.ts`) | Lean theorem |
|---|---|
| `k.never-bricked` — the stable slot is never emptied | `never_bricked` |
| `k.never-dual-run` — at most one live incarnation | `never_dual_run` |
| journal write-ahead — an entered phase was journaled first | `journal_write_ahead` |

All three together: `protocol_guarantees`.

The model is a **1:1 projection of the real source**: the 7 phases come from
`core/src/txn/state.ts::TxnPhase`; the transitions come from
`core/src/txn/transitions.ts::TRANSITIONS`; the snapshot fields mirror
`WorldSnapshot`. Reachability is **operational** — a machine is reachable iff
it is `runStep n` from the initial state for some `n` — so the proofs run
directly against the transition function rather than a hand-tuned reachability
predicate.

## Reproduce

Requires [elan](https://github.com/leanprover/elan) (Lean's version manager).

```sh
elan run leanprover/lean4:stable lean formal/Protocol.lean
# prints only warnings and exits 0 if the proofs hold
```

The proofs also compile with a delegated Lean 4.10.0 toolchain if a later
release is pinned for other reasons.

### Toolchain note (why the file uses `theorem`, not `lemma`)

A recurring parser quirk across Lean 4 releases: a **multi-clause recursive
`def`/`inductive` block immediately followed by a `lemma` declaration** fails
with `error: unexpected identifier; expected command` (reproducible with the
two-line `def f : Nat → Nat | 0 => 0 | n+1 => f n` followed by any `lemma`).
Declaring the proof with **`theorem` instead of `lemma`** avoids it. This file
Therefore uses `theorem` for every proof, so it compiles on both the default
`stable` toolchain (v4.33.0) and v4.10.0.

## Keeping the model in step with the code (the model↔impl gap)

A Lean model proves the *protocol model*, not the TypeScript implementation.
There is no mature automatic TS↔Lean extraction, so the model stays a truthful
projection of the source by discipline, not by construction. Recommended, in
ascending cost:

1. **Naming/shape contract.** Keep `Phase`, the transitions, and the snapshot
   field names identical to the TS source (this file already does). Where CI
   can, assert the shapes agree so a drift is visible instead of silent.
2. **Property test the real engine.** Run model-based property tests against
   the actual `createUpgrader`/`UpgradeEngine` (not a mirror), asserting the
   same properties the Lean model proves — this binds "the properties the model
   proves" to "what the real code actually does".
3. **(Long-term) extraction.** Generate or hand-write the TS transition core
   from the verified model and lock the two together by test.

What the model deliberately does **not** claim (same boundary as the invariants
in `core/src/invariants.ts`): the model abstracts away the host/IO boundary —
real process liveness, OS surfaces (macOS login item, systemd/launchd/windows-
task), and the `HostAdapter` assume-guarantee contract. Those stay verified by
the existing crash-injection harness in `harness/`, not by Lean.
