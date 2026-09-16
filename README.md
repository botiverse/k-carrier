# K (k-carrier)

**Reliable application upgrades, run by an independent installer.**

K is for applications you distribute yourself to end users' machines, across
operating systems, outside any package manager: desktop agents, background
services installed by `curl | sh`, CLIs that update themselves. Nobody
operates those machines. A failed upgrade means the product silently stops
working and nobody can log in to repair it. K combines a rustup-style external
installer with recoverable, verified service upgrades.

K stages verified bytes in a second slot, stops the service, starts and probes
the candidate, then commits or restores the previous executable. A durable
journal lets a later installer recover interrupted work. An upgrade ends
promoted, rolled back, or explicitly unresolved with the evidence preserved;
it is never reported as a success K did not observe.

If a package manager, container image or fleet orchestrator already owns your
installation, that manager owns upgrades too; you probably do not need K.

## Rust integration

The installer is a native Rust executable. The application it controls can be
written in any language and has no K dependency.

The published crate is `k-carrier` 0.3.1. Pin the version in the installer's
Cargo manifest and commit `Cargo.lock` for reproducible application builds:

```toml
k-carrier = "=0.3.1"
```

Use a pinned Git revision only when intentionally testing changes that have not
been published. A repository's manifest version alone does not prove that a
matching crate release exists.

Construct `runner::Runner` with a `storage::FileStore`, an `Arc<dyn host::Host>`
and an `Arc<dyn artifact::ReleaseSource>`. `host::CommandHost` implements the
host boundary with a separately packaged controller using the v1 JSON protocol.
`serve::serve_runner` validates bounded stdin before constructing the adapter;
`supervisor::supervise_bytes` stages a verified independent worker and requires
an operation-bound terminal receipt. Keep the controller and runner outside the
resident application's upgrade slots.

- `storage::bootstrap_stable` adopts trusted initial bytes under the shared lock.
- `Runner::{upgrade_to,recover,status,rollback}` implement policy, convergence,
  durable receipts, replay and recovery; `Runner::execute` exposes the wire API.
- `artifact::{Downloader,ReleaseSource}` provide bounded verified transfer,
  resume, gzip and application-defined release selection. `source::StaticManifestSource`
  is an optional manifest policy, not a required distribution platform.
- `report::ReadbackSurface` declares actual lifecycle readback. Undeclared
  surfaces remain `null`; they never imply lifecycle convergence.
- `quarantine` moves abandoned state aside only with an explicit safe-handoff
  decision. `invariants`, `harness` and `acceptance` are the Rust verification API.

Run `cargo doc --no-deps --open` for the typed API. The complete native example
is in [examples/README.md](examples/README.md). Its controller demonstrates a
loopback service. Integrations with launchd, systemd or another service manager
belong in the product's controller.

## Verification

```sh
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features
python3 scripts/verify-native-examples.py
cargo run --locked --bin k-harness -- sim --seeds 256 --start-seed 1 --json
elan run leanprover/lean4:v4.34.0 lean formal/Protocol.lean
```

Rust 1.89 is pinned by `rust-toolchain.toml`. Build, tests and runtime execution
have no Node dependency. The previous implementation has been removed; fixed v1
format samples and native process tests protect compatibility. Python 3 runs
the example walkthrough and documentation checks. Run `python3 scripts/check-docs.py`
to validate local documentation links and source references.

The harness provides:

```sh
cargo run --bin k-harness -- --list --profile service --json
cargo run --bin k-harness -- --profile service --json
cargo run --bin k-harness -- sim --seed 3737844653 --json
cargo run --bin k-harness -- --bin ./app --target ./k.target.json --json
cargo run --bin k-harness -- --adapter ./controller --target ./adapter.json --json
```

Profiles require the crate source and Cargo. Simulation and external target
verification run in the native CLI. Simulation failures are atomically merged
into `.k-harness/sim-failures.json` (override with `--record-failures`).
See the [migration and verification matrix](RUST-MIGRATION.md) for platform
limits and the old-to-new API mapping. Passing model tests does not prove an OS
service manager works; those gates use actual target-platform processes.

## Repository layout

| Path | Contents |
|---|---|
| `src/` | Rust transaction engine, runner, supervisor, adapters and harness |
| `tests/` | Native integration, crash, transfer, compatibility and mutation checks |
| `examples/` | Native application, controller, self-swap CLI and supervised installer |
| `formal/` | Lean 4 two-slot model and machine-checked proofs |
| `docs/` | Current integration guide, wire reference, design and verification documentation |

Incubating · Rust · Apache-2.0.

## Publishing

The version tag must match `Cargo.toml`. The publishing workflow first requires
all three native CI platforms and Lean, then checks `cargo publish --dry-run --locked`
and uses crates.io Trusted Publishing. Configure the repository and workflow in
the registry before tagging a release. CI packaging does not publish a crate.
