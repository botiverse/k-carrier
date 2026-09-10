# External updater research — 2026-09-06

Question: can installation, self-update and remote upgrade share one external
operations executor, without installing another permanently self-updating
program? Sources below were read for this change; conclusions about K are design
inferences, not guarantees supplied by those projects.

## rustup: borrow the execution boundary, not an imagined lack of state

[rustup-init.sh](https://github.com/rust-lang/rustup/blob/main/rustup-init.sh)
detects the platform, chooses a download URL, executes the downloaded installer,
and removes temporary files. An explicit RUSTUP_VERSION selects an archived
installer. The shell does not contain the Rust installation implementation.

[self_update.rs](https://github.com/rust-lang/rustup/blob/main/src/cli/self_update.rs)
`prepare_update` resolves a version, downloads its rustup-init executable and
makes it executable; `update` invokes the replacement path. The helper lives in
CARGO_HOME/bin in this path, and cleanup may happen on a subsequent invocation.
Thus “one-shot” does **not** mean the helper has no release version or that
cleanup always happens immediately.

[Unix self-update](https://github.com/rust-lang/rustup/blob/main/src/cli/self_update/unix.rs)
`run_update` waits for `--self-replace` and rejects a failing status;
`self_replace` calls `install_bins`. The real installer can be the new program's
binary running in an installation mode; a separately maintained K daemon is
not implied.

[Windows implementation](https://github.com/rust-lang/rustup/blob/main/src/cli/self_update/windows.rs)
and the cross-platform self-update comments account for executable replacement
and deletion constraints. We cannot generalize Unix wait/cleanup into a tested
Windows service handoff merely by using a different PID.

K inference: share a fresh helper across entry points. Persist operations outside
it. Keep distribution trust, schema compatibility and recovery ownership explicit.

## Tailscale: installation ownership and lifecycle are separate obligations

[clientupdate.go](https://github.com/tailscale/tailscale/blob/main/clientupdate/clientupdate.go)
contains platform/package-specific update paths. Its Linux binary replacement
path separately attempts systemd/init.d restart and reports when bytes updated
but restart failed. That is useful evidence that installation and running-state
success are different facts; it does not establish a K-style transaction or
prove that no other Tailscale path has rollback.

K inference: the framework should not swallow restart failures into an exit-zero
upgrade. Delegate package-manager-owned installations to their owner rather than
inventing a universal file replacement routine.

## Datadog: existing experiments are useful, not grounds for a new control plane

The previous repository survey is preserved in
[prior-art.md](prior-art.md). This change also
checked the published [installer test interface](https://pkg.go.dev/github.com/DataDog/datadog-agent/test/new-e2e/tests/installer/windows): it distinguishes
direct installation from starting/promoting/stopping experiments through the
installer service. The current raw repository path guessed during this research
was unavailable; we do not claim a fresh audit of its implementation internals.

K inference: keep the already implemented stable/experiment, journal and host
adapter machinery. A permanent installer service is one deployment option, not
a requirement for this library's disposable runner.

## What actually changes in K

At base `fe0ddce65af780be3342ab1e2186f1ea11415ca0`, K already has public
`recover()`, single-operation locking, two slots, a HostAdapter and durable
operation receipt. Therefore wrapping `upgradeTo()` is not the missing framework.
The gaps addressed here are an independently executable distribution, a strict
request boundary, a command-controller integration, truthful process completion,
and receipt retention without transport ACK blocking the next operation.

| Existing property | Kept | New consequence |
|---|---|---|
| Shared engine and journal | Yes | No second installer state machine |
| Target version chosen by ReleaseSource | Yes | Requested version checked against returned release |
| HostAdapter methods | Yes | External command implementation; app has zero K code in demo |
| Same K lock | Yes | Concurrent runners cannot transact simultaneously |
| Terminal receipts | Archive and replay | Transport delivery never blocks the next operation |
| Recovery after interrupted service handoff | Yes | Fresh downloadable runner can own it while application is down |
| Native per-platform delivery | Publisher responsibility | Bundled Node helper implemented; no claim of published native binaries |

The design and executable acceptance cases are in
[one-shot-runner.md](one-shot-runner.md). The API surface intentionally remains
small: a package dependency solver, fleet policy database, second job journal,
and automatic data migration framework would add unrelated complexity.
