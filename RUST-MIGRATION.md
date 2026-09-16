# Rust migration completion gates

The production implementation, CLI, independent worker and examples are Rust.
The frozen TypeScript implementation in `legacy/` is a compatibility reference,
not a runtime dependency. Final platform and distribution gates remain explicit
below; a compile check is not a service-manager acceptance result.

Required final scope:

- [x] Rust transaction engine, typed states, WAL, atomic slots and executable publication.
- [x] Old TypeScript state/receipt/report/provenance/lock compatibility; fail closed on unknown formats.
- [x] Release sources, static manifests, gzip, verified resumable transfer, response/idle/total bounds, proxy support.
- [x] Ownership/policy/consent/compatibility gates, progress, notifications, provenance, operation replay/archive.
- [x] Live incarnation and declared lifecycle convergence, status, retirement gates, quarantine.
- [x] Strict runner/controller protocols, bounded real subprocess calls, orphan fencing.
- [x] Independent supervisor/worker, matching receipts, crash recovery and bounded retries.
- [x] Rust fault harness, transition-derived crash matrix, seeded simulation and mutation self-checks.
- [ ] Elephant Rust CLI: install/status/upgrade/recover, four targets, service/enrollment integration, refresh and downgrade policy.
- [ ] Remove production Node SEA/TypeScript installer/K dependency; update build/release/CI and examples.
- [x] Rust unit/integration checks, old-format fixtures and real process faults pass.
- [x] Elephant real macOS and Linux service install/upgrade/rollback/interrupted recovery pass.
- [ ] Release artifacts and size measured; installer runs without Node on target.
- [ ] Final audit of existing public behavior/test contracts; no silently dropped assertions or platforms.

Existing Lean models/proofs remain applicable specification artifacts and must be
checked alongside the new engine's transition mapping. Do not substitute mocked
service managers for target-platform verification. Use only temporary identities,
services and artifacts, clean on failure, and keep credentials out of evidence.

## API and harness migration

| Previous TypeScript entry | Rust replacement |
|---|---|
| `createRunner`, `Upgrader` | `runner::Runner`, `UpgradeOptions`, `Hooks` |
| `bootstrapStable`, slot paths | `storage::bootstrap_stable`, `FileStore::artifact` |
| `ReleaseSource`, `downloadVerified` | `artifact::ReleaseSource`, `Downloader` |
| `HostAdapter`, `createCommandHost` | `host::Host`, `CommandHost` |
| `serveRunner`, `executeRunnerRequest` | `serve::serve_runner`, `Runner::execute` |
| `launchRunner`, offline resume | `supervisor::{supervise_release,supervise_bytes,resume_runner}` |
| report/provenance/operation stores | `report`, `state`, `FileStore` |
| safe quarantine | `quarantine::quarantine_state` |
| invariants and in-process fake host | `invariants`, `harness::FakeHost` |
| `k-harness sim`, seed replay/corpus | native `k-harness sim`, `corpus` |
| `--bin` and executable `k.target.ts` | `--bin` and explicit `k.target.json` with real candidate |
| dynamically imported `--adapter` | native controller plus `AdapterTarget` JSON; Rust traits for custom workload/lifecycle checks |
| registered TS acceptance teeth | named Rust integration suites, negative controls, before/after effect crash matrix |

The Rust harness does not execute arbitrary TS adapter modules. JSON target
files declare data and native commands. External adapter receipts state exactly
which checks ran; service-manager/workload capabilities are verified through
Rust `ReadbackSurface`/invariant integrations and Elephant's real OS tests.
The seeded model exercises the production engine, promotion, predicate refusal,
crash boundaries and recovery. Network stalls, partial writes and OS crashes
are separate real I/O tests rather than claims inferred from the model.

## Local evidence during migration

- Original TypeScript baseline: 374 tests plus types/lint/ratchets passed before
  archival. The archive is frozen; no assertions were removed to obtain that pass.
- Rust/macOS arm64: format, Clippy (warnings denied), native integration suites,
  actual Node↔Rust state/lock interoperability, example installer and self-swap
  passed. The example runs with no usable PATH and no Node.
- Rust/Linux arm64: real process recovery and native adapter tests passed in an
  isolated Ubuntu 24.04 VM. The first manifest-source test used OrbStack's proxy
  for a loopback fixture; fixed by explicitly isolating that fixture client.
  A separate subprocess test verifies real environment-proxy behavior.
- Elephant/macOS arm64 and Linux arm64: native HTTPS installation, repeated
  enrollment, stable identity, upgrade, rollback, independent worker kill and
  supervisor kill/recovery passed against actual launchd/systemd services.
- Linux systemd surfaced start-limit-hit after rapid legitimate handovers; the
  controller now resets that unit's failed state before an explicit start while
  retaining the automatic crash-loop limit. Actual service tests passed after
  the fix; no timing/assertion relaxation was used for that failure.
- Linux ELF test fixture DWARF had dominated copied-worker deadlines. Test
  builds omit debug information; process deadlines and fault assertions remain
  unchanged. Cold compilation uses a separate test/build envelope.
- Lean `Protocol.lean` checked with Lean 4.34.0.
- `cargo package --allow-dirty --locked` rebuilt the packaged Rust source.
- Windows runtime, Linux amd64, final four-asset release and exact final-commit
  CI verification are pending. macOS x86_64 startup has only Rosetta evidence.

No production faults, deployments, release tags or crate publication are part
of these local checks. Test identities, processes and services are isolated.
