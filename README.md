# K

**Upgrade framework for managed resident services on personal devices.** (private while incubating)

Existing tools solve the two easy ends: CLI self-update libraries (`self_update`, `minio/selfupdate` — fetch/verify/swap, effective on restart) and org-fleet updaters (Datadog fleet installer — remote-driven, machines owned by ops). **Nobody covers the middle: a resident service on a machine a *person* owns, hosting live workloads.** That demands the *union* of both ends' capabilities, plus a few nobody has:

- transactional upgrades with rollback (two-slot `{stable, experiment}` + journal; crash-safe at every step)
- resident-service handoff with **workload/session preservation** (host implements a small `HostAdapter`; core never knows host internals)
- **convergence readback**: an upgrade must mechanically *prove* it happened — `binary_at_target` (same-PID version probe) and `host_lifecycle_converged` (named-SSOT readback, e.g. macOS login-item via Electron `getLoginItemSettings`); version strings and channels are *banned* as proxies for either
- consent & notification on personal devices (`auto | confirm | notify-only`; the notification path itself is test-verified)
- optional fleet drive & observation (server-pushed stage/promote/rollback gated by local policy; install-provenance journal, honest `NOT_OBSERVED` for pre-existing machines)

## Layers

| Layer | What | Provenance |
|---|---|---|
| L0 `artifact` | channel resolve · download · verify · atomic swap | commodity; `self_update`-shaped API |
| L0.5 `distsign` | 2-tier Ed25519 (offline roots compiled in → rotating signing keys → per-file sigs); server stays static files | Tailscale distsign, re-implemented |
| L1 `txn` | two-slot repo + append-only journal + crash-recoverable state machine; config rides the same rails | Datadog fleet installer model |
| L2 `lifecycle` | `HostAdapter` (quiesce/stop/start/probe/resume) + handoff orchestration | ours |
| L3 `converge` | predicates + same-source readback + fail-closed retirement order | ours (Raft #395 spec) |
| L4 `policy` | consent knob + verifiable notification sink | ours |
| L5 `drive` | optional remote command projection + state report + provenance journal | Datadog shape, policy-gated |

## Repo layout

```
core/        the framework — zero host-specific concepts (enforced by design & tests)
harness/     generic acceptance bed: fake-host daemon + full teeth
             (crash-injection matrix per state-machine edge, predicate teeth,
              projection-ban teeth, verified-notification tooth)
raft-shell/  first host: Raft Computer adapters (upgradeSea / CLI / installer
             entrypoints all delegate to the same core)
docs/        design-v1.md · research-tailscale-datadog.md
```

Design doc: [`docs/design-v1.md`](docs/design-v1.md) · Integration guide: [`docs/integration.md`](docs/integration.md). Testing doctrine is half the point: the harness runs against *any* `HostAdapter`, so the test suite itself is the proof of genericity.

Status: incubating. Language: TypeScript to start (first shell shares the stack). License: decided at publish time (leaning Apache-2.0).
