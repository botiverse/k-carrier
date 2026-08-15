# K v2 Effect architecture

## Boundary of the experiment

Effect owns dependency injection, typed failures, scoped lock release, runtime
lifecycle, and composition. It does not own the transaction truth. The journal,
slot state, host process evidence, and action-id receipts are the information a
new process can actually recover from.

The design therefore has two APIs:

- `@botiverse/k-carrier/effect` exposes Effect programs and service tags.
- the default entry builds those same programs from a Promise adapter and keeps
  Effect types out of the consumer-facing signature.

## Durable state machine

```
staged
  -> handover
  -> experiment_running
  -> verifying
  -> committed

any definite host or predicate failure after staging
  -> rolled_back
```

Every arrow into an external mutation is represented by a synced journal entry
first. `committed` and `rolled_back` are intents whose effects may still need to
be replayed after a crash. The corresponding slot and host operations are
therefore idempotent.

`HostOutcomeUnknown` is intentionally different from `HostFailure`. A definite
failure may enter rollback. An unknown result returns immediately and preserves
the current journal phase. A later process probes live state and converges using
the same stable action ids.

## Services

- `Journal`: unknown input on read, schema validation in the kernel, and synced
  typed entries on append.
- `KClock`: the only source of protocol timestamps.
- `Slots`: durable stable/experiment artifacts and idempotent promote/clear.
- `ReleaseSource`: resolves a named target to an immutable artifact.
- `Host`: quiesce, stop, start, resume, and process evidence; mutations are
  deduplicated by action id.
- `Verifier`: product-specific live predicates over target evidence.
- `UpgradeLock`: process/fleet serialization with scoped release.

Expected operational failures remain in the typed error channel. Programmer
defects and simulated process death are defects, so ordinary recovery handlers
cannot accidentally reinterpret them as rollback instructions.

## Why no Effect retry or timeout

Effect schedules are useful for reads whose contract permits repetition. They
are deliberately absent from this kernel. A timeout says the caller stopped
waiting; it does not prove that an OS mutation stopped. Automatically issuing a
new stop/start after that point can create a second live incarnation. Adapters
must surface an unknown outcome and let a later recovery turn reconcile it.

## Production gaps

This spike does not yet implement artifact streaming, signatures, platform
swap primitives, fleet drive, consent, reporting, or the full 0.1.x integration
surface. Effect 4 is also forthcoming, so a production K v2 would need an
explicit 3-to-4 migration decision before adopting this runtime shape.
