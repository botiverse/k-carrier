# External installer research

The 2026-09-06 survey asked whether install, self-update and remote upgrade could
share an external executor without introducing another permanent service.
These are source-reading observations and K design inferences, not results from
running those products. Moving upstream links are not a frozen comparison.

## Rustup: a thin bootstrap and replaceable installer

[rustup-init.sh](https://github.com/rust-lang/rustup/blob/main/rustup-init.sh)
selects a platform download and runs the installer. The shell does not implement
Rust installation. [Self-update](https://github.com/rust-lang/rustup/blob/main/src/cli/self_update.rs)
also obtains an installer executable; the helper has a release version and may
remain until a later invocation cleans it up.

[Unix replacement](https://github.com/rust-lang/rustup/blob/main/src/cli/self_update/unix.rs)
and [Windows replacement](https://github.com/rust-lang/rustup/blob/main/src/cli/self_update/windows.rs)
handle different execution/deletion constraints. A different PID alone does not
prove that an updater can survive stopping a service or replace a running Windows
executable safely.

**K decision:** share an independently runnable installer across entrypoints.
Keep its persistent state, runtime, trust and recovery ownership explicit.

## Tailscale: installation and service readiness are separate

The surveyed Linux binary path in
[clientupdate.go](https://github.com/tailscale/tailscale/blob/main/clientupdate/clientupdate.go)
attempts a service restart separately and reports when bytes were updated but
restart failed. Platform/package-specific paths respect the installation owner.
This observation does not establish whether other paths have rollback.

**K decision:** successful installation is insufficient for service promotion.
Probe the live process and defer installations owned by another manager.

## Datadog: reuse slots, not a second control plane

The [earlier survey](design-influences.md) informed K's stable/experiment slots.
The published [Windows installer test interface](https://pkg.go.dev/github.com/DataDog/datadog-agent/test/new-e2e/tests/installer/windows)
distinguishes direct install from starting, promoting and stopping experiments.
The follow-up did not verify all current installer internals.

**K decision:** retain the existing transaction, lock, journal and host adapter.
A disposable runner can use them without a permanent installer service or a
parallel remote-job database. Recovery and archived receipts remain local.

The resulting [design](../design.md) specifies a built installer, a bounded
request protocol and an external controller. Product data compatibility,
platform packaging and remote authorization remain product responsibilities.
