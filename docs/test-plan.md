# K v2 experiment test plan

The tests are an executable protocol check, not a claim of 0.1.x feature
parity.

## Baselines

- Promise facade: the default entry completes a full two-slot promotion without
  exposing Effect types.
- Happy path: journal phase order is exact and each intent precedes its slot or
  host effect.
- Clock: the first journal timestamp comes from the injected harness world, not
  the ambient wall clock.

## Fail-closed teeth

- Predicate refusal writes `rolled_back`, restores stable, resumes it, and
  clears the experiment slot.
- Unknown experiment start performs one side effect, emits no later phase and
  does not roll back or retry in the same turn. A fresh recovery process then
  observes and commits the target.
- Crash matrix: collect the complete successful boundary trace, crash after
  every boundary in a separate world, boot a new Layer/runtime, and require a
  terminal state with exactly one stable slot running.

The crash-after-stage row is also the WAL-order tooth: moving `slots.stage`
before the synced `staged` entry leaves an orphan experiment and makes that row
red. The crash-after-promote row proves that a `committed` intent can finish
after the durable slot move. The unknown-start row turns red if the kernel
continues the turn or records an outcome it did not observe.

## Mechanical ratchets

- no Effect types in the default entry;
- no automatic retry/schedule calls in production source;
- no raw time API in production source;
- no TypeScript escape hatches;
- every test file declares `@invariant` or `@baseline`.
