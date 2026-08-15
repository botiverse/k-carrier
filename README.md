# K v2 Effect experiment

This branch is an intentionally private, from-scratch experiment. It is not a
successor release of `@botiverse/k-carrier@0.1.x`, and it has no publish
workflow.

The experiment asks one narrow question: can Effect provide the in-process
execution model for K without weakening the durable upgrade protocol?

## Resulting shape

```
src/domain.ts       pure, schema-checked durable protocol data
src/services.ts     Journal / Clock / Slots / Source / Host / Verifier / Lock
src/kernel.ts       Effect-native upgrade and recovery programs
src/facade.ts       Promise adapter and managed runtime boundary
src/effect.ts       opt-in Effect-native entry
harness/src/        deterministic Layer-backed host and crash matrix
```

The default export is Promise-only. Consumers that already use Effect may use
the `/effect` entry and provide their own Layers.

## Protocol rules

1. The synced journal is the authority across process death. Fiber state is
   never recovery evidence.
2. A host mutation carries a stable action id. An unknown result ends the
   current turn; K does not issue a second mutation. Recovery may reissue only
   that same id, which the adapter must deduplicate.
3. Only the short journal append-and-sync operation is uninterruptible. Host
   calls never run inside an uninterruptible region.
4. Time enters through exactly one `KClock` service. The deterministic harness
   supplies it from the same world that supplies crash scheduling.

Slot `promote` and `clearExperiment` operations must be idempotent. A Journal
implementation must reject or serialize concurrent writers and must not resolve
`append` before durable sync. A Host implementation must persist the action-id
deduplication receipt at least as durably as the side effect it guards.

## Running the experiment

Node 24 and pnpm 11 are required.

```sh
pnpm install --frozen-lockfile
pnpm check
```

The crash test first records every boundary on a successful run, then boots a
fresh runtime after a simulated process death at each boundary. It requires a
terminal committed or rolled-back journal, one running stable slot, no staged
artifact, and no retained process lock.

See [`docs/design-v2-effect.md`](docs/design-v2-effect.md) and
[`docs/test-plan.md`](docs/test-plan.md). The initial footprint measurements
are in [`docs/experiment-results.md`](docs/experiment-results.md).
