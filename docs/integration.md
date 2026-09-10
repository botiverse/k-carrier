# Integrating K with an application

Build a disposable external runner containing K and a trusted application adapter.
The application exposes lifecycle and health controls; it does not execute K.
The [design](design.md) defines this execution boundary and the
[runner protocol](one-shot-runner.md) specifies requests and results.

## Publish three deliverables

Using K means distributing **a bootstrap script, a K installer/upgrader, and your
product's release**. K is the reusable framework; you build the installer with
your trusted product adapter. Installing the framework dependency alone does not
publish these deliverables for you.

| Deliverable | Built and published by | Downloaded or started by |
|---|---|---|
| `install.sh` | Your product's release process | The person installing the product |
| Installer/runner containing K and your adapter | Your installer build, with its own version | `install.sh` or `self upgrade` |
| Product executable | Your application's release build | The runner's ReleaseSource |

For example, one CDN could serve this layout (illustrative paths, not K's required
URL scheme):

```text
https://downloads.example.com/my-service/
  install.sh
  installers/1.4.1/linux-x64/runner.mjs
  installers/1.4.1/manifest.json
  releases/2.8.0/linux-x64/service
  releases/2.8.0/manifest.json
```

Here the bootstrap script selects installer **1.4.1** for the host platform,
obtains its authenticated download URL, SHA-256 and size, verifies it, then runs
it with an upgrade request for product **2.8.0**. The runner's adapter resolves
that product version to its own URL, SHA-256 and size and K verifies those bytes
before staging them. `self upgrade` delegates to the same runner contract. It
must arrange execution outside the service's process-management boundary too.

The manifests stand for your distribution metadata; K does not require one
shared manifest format for both downloads. The launcher accepts a runner Release,
and the adapter implements the product ReleaseSource. Keep those identities
separate even when both are served by Hands or the same CDN. A checksum detects
changed bytes; the trusted delivery of the script and metadata establishes who
published them.

The `.mjs` runner in this example requires an independently available Node 24;
it is not a standalone native executable. Supply that runtime through your
installation prerequisites or package a native runner for each platform. The
runtime must remain usable when the product is stopped or replaced.

You can release installer **1.4.2** to repair installation logic while continuing
to install product **2.8.0**. Publish the new runner and its metadata, then update
the launcher's selected installer release. Both entrypoints need a defined way
to obtain that selection; publishing new bytes alone does not update a launcher
that pins the old release. Preserve published versioned artifacts rather than
silently replacing the bytes behind a fixed hash.

External execution also lets product-specific setup code repair or archive old
installation state without requiring the old application to start. Keep that
work in the installer adapter, with explicit ownership and data-preservation
rules. Ordinary K `recover` only settles its recorded transaction; it does not
delete user data or act as a general repair command. Installer independence does
not make arbitrary older runners safe to run against newer persistent state.

## Execution roles and persistent state

The three deliverables above are a distribution model. At execution time, these
are the roles involved:

| Piece | Built or supplied by | Responsibility |
|---|---|---|
| Launcher | Your installer, operator CLI or supervisor | Authenticate/download the runner and start it outside the application's service unit |
| Runner | Your publisher bundles K with a trusted adapter | Select the application release through the adapter and own the transaction |
| Application controller | Your integration | Stop/start/probe the application; it can be command-based or implement HostAdapter directly |

The adapter is configuration and trusted code inside the runner, not an extra
resident daemon. `createRunner(options)` returns the transaction interface;
it does **not** spawn a process. `serveRunner(factory)` handles stdin/stdout;
`launchRunner(...)` starts the built helper and returns its exit code, forwarding
stdout/stderr. The helper release and application release are separate artifacts.

Allocate a persistent `stateDir` for each installation. All upgrades and recovery
attempts for that installation use the same directory; unrelated applications use
different directories. Protect it as application management state. Keep application
data and temporary runner code outside its slots.

## 1. Define the application contract

The current integration API requires a HostAdapter. There is no profile flag or
host-free default: this guide integrates a resident service. Implement quiesce,
stop, start, healthProbe and resume through an external controller. Stop must confirm termination; start must be idempotent;
probe must return version, pid and startId from one live incarnation. Quiesce and
resume must preserve the workloads you promise to preserve, including rollback.

Declare installation ownership, consent policy, notification sink and a trusted
ReleaseSource. A package-manager-owned installation must report managed-elsewhere.
Implement `checkCompatibility(from, to)` when application data or protocol changes
can make a transition unsafe. K restores binaries, not application data; provide
backup/restore independently for destructive migrations.

## 2. Establish the rollback baseline

Before the first upgrade, the stable slot must contain trusted, usable application
bytes. For an existing installation, call `bootstrapStable({stateDir, version,
artifactPath})` from a trusted setup step with its current executable. This seeds
the fallback; it does not download a release, authenticate the input or start the
service. It refuses conflicting transaction state and does not overwrite an
initialized stable slot. Run this once, not as a way to reset failed upgrades.

The controller must be able to start the slot selected by K, using
`slotArtifactPath(stateDir, slot)` or the path supplied by `createCommandHost`.
K manages an `artifact.bin` per slot; a product needing a package layout or install
hooks must supply that contract explicitly. The service example copies its selected
script to an `.mjs` runtime path because Node needs the module extension.

See the [walkthrough](../examples/external-service/README.md) for concrete setup,
upgrade, observation and cleanup commands.

## 3. Build the runner

Use `createRunner(options)` inside the trusted adapter, as shown in
[external-service/adapter.ts](../examples/external-service/adapter.ts). Configure
`stateDir`, `source`, `host` and policy there. The application controller can use
`createCommandHost`; the protocol cannot select arbitrary adapter code or commands.

```sh
pnpm install --frozen-lockfile
node scripts/build-runner.mjs examples/external-service/adapter.ts /tmp/k-runner.mjs
```

The example requires an independently installed Node 24. Follow the
[example setup](../examples/external-service/README.md) before running it.
For product delivery, publish and authenticate the runner artifact and interpreter
with your platform's distribution mechanism. SHA-256 and size are integrity checks,
not publisher signatures.

## 4. Launch from outside the application

Keep runner code and scratch space outside both application slots. Launch it from
an operator shell or external supervisor that survives stopping the application.
Spawning a child inside the application's service unit does not establish isolation.
An installer may use `launchRunner` to download, verify, execute and clean the
helper; it must not implement its own swap or rollback logic.

```sh
printf '%s' '{"protocolVersion":1,"action":"upgrade","id":"install-2","targetVersion":"2.0.0","consented":true}' | node /tmp/k-runner.mjs
```

Only pass `consented: true` after the launcher's authenticated caller has approved
the operation. Logs go to stderr; stdout is reserved for the response. A Web UI
needs an external launch facility and queries the durable result after reconnect.

## 5. Observe, retry and recover

Read the response's operation and exit code, not only its `result` string.
A successful recovery can return exit 1 because it restored the old version and
recorded `rolled-back`; that means the upgrade did not succeed, not necessarily
that recovery failed. Exit 2 denotes a policy hold and 3 unresolved work.
Inspect `operation.operation.outcome` (when `operation.kind` is `observed`), its
`reason`, and the response `error` to distinguish them.

`status` reports the current receipt only, with no lifecycle calls; it does not
prove current live health. `genesis` means no receipt has been recorded, not that
the service is uninstalled. There is no archive-list or by-id status action; a
same-id upgrade retry replays its current or archived result without re-executing
the transaction. Reusing an id with a different target is
rejected. Use a new id for a new attempt, after resolving any active transaction.

Terminal receipts archive automatically before replacement. There is no delivery
confirmation action or gate. Active operations, unreadable state and live lock
owners still prevent starting a conflicting transaction.

After runner failure, launch a verified runner and submit `recover`. It settles
persisted work without release lookup: before durable promote intent, restore
stable; after that intent, replay the commit. The launcher or external supervisor
owns restarting recovery after power loss. Never infer completion from process
spawn alone or bypass the lock to clear an unresolved result.

## 6. Verify application behavior

Run `pnpm check` and the external process tests, then test your actual controller
on each supported platform. Verify stop/start, one-incarnation readiness, broken
candidate rollback, runner death between stop and start, and recovery with the
release source unavailable. Check workload restoration and application data
compatibility independently. If you declare OS lifecycle surfaces, read them back
before retiring their previous manager; undeclared observations are not passes.

The other repository examples and harness modules exercise internal engine
mechanisms. They are test fixtures, not alternate application integration paths.

## Using Hands as the release platform

Hands owns application publication and distribution policy; K owns a transaction
on one installation. The product adapter connects them through ReleaseSource:

```text
Publisher → Hands release/channel/platform selection → product ReleaseSource
                                                      ↓
Launcher → K runner → verified application bytes → stage / probe / commit or rollback
```

The product adapter maps a Hands-selected artifact to `{version, url, sha256,
size}`. It supplies app identity, platform and channel/cohort policy to the release
platform, and must refuse missing or mismatched targets. An `upgrade` request
names an exact application version; it must not silently become a moving latest
release. K itself has no Hands account, app slug, channel or rollout percentage.
Access control and any authenticated manifest/download resolution belong to the
adapter and launcher's distribution boundary.

A launcher may also obtain the runner artifact from Hands. That is a separate
artifact identity from the requested application version: verify the helper before
executing it, then let its adapter resolve the application release. Publishing a
release is not evidence that a machine installed it. If installation results are
reported to a server, forward K's operation id and outcome; do not invent success
from a download or process-start event. The current runner provides local receipts,
not an automatic Hands status uploader.

Withdrawing a Hands release changes distribution policy; rolling back in K restores
this installation's previous stable bytes. A fleet rollback would require an
explicit command path and local execution on each device, not merely a channel
change. K's recovery can restore existing slot bytes while the release source is
unavailable; this does not guarantee an online source can authorize or download
an arbitrary historical version.

This describes the integration boundary, not a bundled Hands connector or evidence
of a deployed product integration. The runnable example uses a local release
manifest so its tests do not depend on a live Hands service.
