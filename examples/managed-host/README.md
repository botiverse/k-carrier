# managed-host — the managed-profile example

**Proves:** the managed profile's support claim — a host with live
sessions preserves them byte-for-byte across quiesce↔resume, including
resume after a rollback to the stable slot, and its probe evidence binds
to the live incarnation (pid + per-incarnation startId).

Accepted by `k-harness --adapter examples/managed-host/host.ts` (contract
subset: ledger equivalence ×2 + probe veracity/binding) and by the
registered tooth `examples.managed-host-adapter` in the managed tier.

Source: `host.ts` — the demo's OWN HostDriver (a real adopter brings its
own host; this is a from-scratch reference). Session state = counter +
rolling sha256 chain in `<stateDir>/session.bin`, durably parked at
quiesce. The full managed upgrade loop (L1 two-slot + L4 policy/consent +
L5 drive) lands when the core upgrader wiring does; the contract surface
is today's credential.
