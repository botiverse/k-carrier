# Prior art: how k-carrier relates to Tailscale and Datadog updaters

This document is the design-rationale and license-defense record behind the
`NOTICE` file. k-carrier's architecture was informed by studying two mature,
unrelated self-updating systems. **Only architectural concepts were studied; no
source code was copied**, and the implementation here is original. This note
records what each project does, what k-carrier deliberately reuses, and where it
does something neither project attempts.

Both projects were read first-hand from their upstream `main` branches:

- **Tailscale** — `tailscale/tailscale`: `clientupdate/` (`clientupdate.go`,
  `clientupdate_windows.go`, `clientupdate_downloads.go`) and
  `clientupdate/distsign/` (`distsign.go`).
- **Datadog** — `DataDog/datadog-agent`: `pkg/fleet/installer/`
  (`installer.go`, `oci/`, `packages/`, `db/`) and `pkg/fleet/daemon/`
  (`daemon.go`, `remote_config.go`, `local_api.go`, `task_db.go`).

## Tailscale `clientupdate`

- **Single package, dual entry point.** One `clientupdate` package is shared by
  the `tailscaled` daemon and the `tailscale` CLI — a single canonical executor
  reached from two binaries.
- **Track model.** stable / unstable / release-candidate; the minor version's
  parity selects the track; a `Confirm(newVersion)` callback gates the upgrade.
- **Platform matrix = "defer to whoever owns the install."** A dispatch table
  routes apt / dnf-yum / apk / Synology / QNAP / FreeBSD pkg each to its native
  package manager; macOS GUI builds go through Sparkle; the Mac App Store build
  cannot self-update; Arch only prints guidance (it respects pacman's
  ownership). Every branch carries a `canAutoUpdate` flag.
- **Bare-binary line (Linux).** require-root → resolve version → confirm →
  download + verify a tarball → unpack over the install → restart via the
  service manager.
- **Windows.** MSI plus a self-copy trick (copy the running executable to a temp
  path and run the installer from there to avoid self-locking) + Authenticode
  verification + a re-entry environment variable.
- **`distsign` signing (the strongest supply-chain idea).** A two-tier Ed25519
  scheme: offline root keys are compiled into the client and sign rotating
  signing keys, which in turn sign the distributed files; the server is just
  static files (`$file` + `$file.sig`); signing keys are fetched dynamically
  before each download; root rotation ships a new client.

**What Tailscale does *not* do** (and k-carrier does): the restart is
best-effort — on failure it prints "please restart manually" rather than
failing closed; there is no post-upgrade read-back (the restart command
returning is treated as success, with no probe of the new daemon's version); and
there is no rollback (the old binary is simply overwritten).

## Datadog fleet installer

- **A self-managing package manager.** It installs and uninstalls packages,
  including the installer itself — the installer is one of the managed packages.
- **Two-slot upgrade transaction (the core idea k-carrier reuses).** Each
  package keeps a `{Stable, Experiment}` pair of slots: `InstallExperiment`
  stages the new version in the experiment slot (with pre/post start hooks), then
  either `PromoteExperiment` (make it the new stable) or `RemoveExperiment`
  (roll back to stable). **Upgrade is a blue/green transaction with rollback**,
  and slot state is readable back. Configuration changes flow through the same
  experiment / promote / rollback machinery.
- **Daemon drive plane.** A remote-config channel pushes a catalog and upgrade
  tasks; the daemon executes them; a task database records the work; `GetState`
  reads back `{Stable, Experiment}` per package — so a fleet's "who is on what
  version / mid-experiment" is observable. The local API is a unix socket /
  named pipe.
- **Distribution = OCI images**, content-addressed by digest (layers verified by
  digest).
- It explicitly sequences self-teardown (on Linux a pre-stop step would kill its
  own process, so it removes the experiment before stopping).

## Dimension-by-dimension

| Dimension | Tailscale | Datadog | k-carrier |
|---|---|---|---|
| Executor shape | single package, dual entry ✅ | standalone installer + daemon drive | one core, shared by multiple entry points — the Tailscale shape |
| Upgrade transaction / rollback | ❌ overwrite, no rollback | ★ two-slot + promote/rollback | fail-closed + rollback — the Datadog model |
| Post-upgrade read-back | ❌ (restart = success) | `GetState` per package | convergence read-back with a version probe — stricter predicate layer |
| Fleet observability | ❌ | ★ remote-config + task-db + state | server-push + read-back drive plane — the Datadog shape |
| Channels / pinning | track + confirm | catalog + remote config | latest / alpha / pinned channel file |
| Signing / supply chain | ★ two-tier offline-root Ed25519 | OCI digest addressing | **integrity-only today (sha256 + size); no signing implemented** — distsign studied as a future key layer |
| Service handoff | Windows self-copy trick | explicit self-kill sequencing | detached service handoff **with in-flight workload/session preservation** |
| OS-supervisor convergence | ❌ (native per-platform services) | ❌ | supervisor retirement + login-item migration + read-back |
| Generic framework | ❌ coupled to Tailscale | ❌ coupled to Datadog's package ecosystem | generic core + a thin host shell |

## The three concepts k-carrier reuses

1. **Core transaction — from Datadog's two slots.** k-carrier's upgrade is a
   `stable` / `experiment` pair with promote / rollback, which naturally gives
   fail-closed behavior, rollback, and read-back state.
2. **Executor shape — from Tailscale's single package.** One core reached from
   several entry points (daemon / CLI / installer), rather than duplicated logic.
3. **Supply-chain layer — from Tailscale's `distsign`.** The two-tier
   offline-root Ed25519 idea is the intended future key layer over the existing
   content-addressed distribution. **It is a studied concept, not present in this
   repository** — k-carrier currently verifies artifact integrity by sha256 +
   size only.

## Why k-carrier exists (the gap)

The two projects sit at opposite ends of a spectrum. Tailscale is a system
service on mostly *personal* devices, so it is deferential to install ownership
(package-manager routing, confirm callbacks, Arch's print-only path). Datadog
manages *fleet* servers/nodes an organization operates, so it can push central
remote-config and read the fleet back (the machines have no "personal will").

k-carrier targets **a managed service running on a personal device**, which is
the *union*, not a midpoint: it wants Datadog's management capabilities
(transaction / rollback / read-back / remote drive / fleet observability) **and**
Tailscale's device-respect (consent / notification / ownership deference), plus
capabilities neither project has — **preserving the host's in-flight workload and
sessions across the swap, and an un-fakeable convergence read-back**. This union
is strictly harder than either project's problem, which is the cleanest
explanation for why no off-the-shelf framework fits: nobody has needed exactly
this superset. That gap is k-carrier's reason to exist as a generic core.

**Layer 0 is a commodity.** Fetching, verifying, and atomically swapping a
binary is already solved by self-update libraries (e.g. Rust `self_update`, Go
`selfupdate`), and by the updaters shipped with CLI agents — because a CLI has no
long-running service to hand off. k-carrier's Layer 0 looks like those and could
even sit on top of one; its value is entirely in the layers above (transaction,
handoff, read-back), which is exactly the list that separates a CLI self-updater
from a managed-service carrier.

## Licenses

Tailscale is **BSD-3-Clause** and the Datadog agent is **Apache-2.0** — both
permissive. k-carrier borrows concepts only and copies no code; the signing idea
is described from the concept and would be written independently if implemented.
k-carrier itself is released under **Apache-2.0** (see `LICENSE` and `NOTICE`).

## Test-design influences

- **Tailscale is unit-only, zero e2e.** Its tests are pure-function / file
  operations (sources.list rewriting as table-driven byte-in/byte-out, repo
  track edits, version parsing, tarball unpack, the confirm callback) plus key
  rotation and a local-server download test. There are no upgrade-e2e, handoff,
  crash, or rollback tests — **the test shape mirrors the design's gaps**: with
  no rollback or read-back, nothing needs an e2e. k-carrier borrows the
  table-driven pure-function style for its platform adapters.
- **Datadog has real-VM e2e.** e2e runs on freshly provisioned cloud VMs (real
  systemd / package managers), with a `host.State()` full-snapshot assertion,
  journald timestamp anchoring (`LastJournaldTimestamp()` → "assert X happened
  *after* the marker", an event-shaped oracle that stops stale events from
  passing as new evidence), ownership-migration scenarios, and failure suites.
  It is slow and expensive. k-carrier borrows the timestamp-anchored assertion
  and the ownership-migration scenario.
- **What neither has** (and k-carrier's harness adds): a crash-injection matrix,
  adversarial self-verification, a mutation contract, a black-box zero-integration
  mode, and a teeth registry with registration discipline. Tailscale's unit-only
  suite restates the lesson: **the test shape follows the design — a design with
  no rollback or read-back never demands tests for them.**
