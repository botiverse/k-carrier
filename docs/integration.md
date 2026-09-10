# Integrating K

Build an independent installer from K and a trusted product adapter. The
application exposes lifecycle/health controls; it does not run K's transaction
engine. Read [how an upgrade works](guide.md) first if you have not, then
start with the [runnable example](../examples/external-service/README.md).
The [design](design.md) states the obligations; the [reference](reference.md)
has protocols, exit codes and file layout.

## Publish three deliverables

| Deliverable | Responsibility |
|---|---|
| Bootstrap script (`install.sh`) | Select, download, verify and launch the installer |
| Installer/runner | K plus your product adapter, published with its own version |
| Product release | The application executable selected by the adapter's ReleaseSource |

All three can share a CDN and build repository. For example:

```text
https://downloads.example.com/my-service/
  install.sh
  installers/1.4.1/linux-x64/installer
  installers/1.4.1/manifest.json
  releases/2.8.0/linux-x64/service
  releases/2.8.0/manifest.json
```

These paths and manifest names are illustrative, not a K schema. The bootstrap
verifies installer 1.4.1, then asks it to install product 2.8.0. The adapter
resolves the product's URL, SHA-256 and size independently. Authenticate both
sets of metadata; hashes alone do not establish publisher identity.

`install.sh` and `self upgrade` use the same runner protocol and installation
state. To ship an installer-only fix, publish a new installer and update their
selection mechanism. Keep versioned artifacts immutable. The controller is an
execution role, not a mandatory fourth deliverable.

## Distribute a built installer

End users download finished artifacts; these build choices belong to publishers.

| Form | Delivered artifact | Runtime requirement |
|---|---|---|
| Single executable per OS/architecture | Node SEA with the runner embedded, built with `--cjs` | No external Node for the worker; supervisor and controller dependencies are separate |
| Cross-platform JavaScript | K and adapter bundled into one `.mjs` | Independently available Node 24 and adapter dependencies |

One JS file is portable only if its adapter and dependencies support the targets.
`scripts/build-runner.mjs` produces both bundle forms; SEA injection, signing
and publication are publisher responsibilities. Whichever form you ship must
survive stopping and replacing the application.

### Build a single executable

Node's single-executable-application (SEA) tooling embeds the runner into a
copy of the Node binary. This recipe uses Node 24.15.0 and a CommonJS entry.
The supervisor executes the result directly, with no
`interpreter` option. This procedure was verified end to end: a SEA runner
promoted the example service under `launchRunner`.

```sh
# 1. CommonJS entry for this Node 24 SEA recipe.
# This demo adapter needs the controller change described below before upgrading.
node scripts/build-runner.mjs --cjs examples/external-service/adapter.ts dist/runner.cjs

# 2. Prepare the blob.
printf '%s' '{"main":"dist/runner.cjs","output":"dist/sea-prep.blob","disableExperimentalSEAWarning":true}' > dist/sea-config.json
node --experimental-sea-config dist/sea-config.json

# 3. Inject into a Node binary for the target platform.
cp "$(command -v node)" dist/runner
# macOS only: codesign --remove-signature dist/runner
npx postject@1.0.0-alpha.6 dist/runner NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
# macOS: add --macho-segment-name NODE_SEA to the postject command
# macOS only: codesign --sign - dist/runner   (use your release identity)

# 4. Publish dist/runner with its sha256 and size; launch it with no interpreter.
```

Build one SEA per target OS and architecture with that platform's Node
binary. Binary size depends on the target Node build. Installer and product
release metadata can include optional gzip transport; both paths use the
same verified downloader.

**The SEA pitfall.** Inside a SEA, `process.execPath` is the SEA itself. An
adapter or controller that spawns `process.execPath some-script.mjs` re-runs
the embedded runner instead of the script, and the upgrade fails at the first
controller call. Make the controller a native executable or its own SEA, or
pass an explicit interpreter path into the adapter at build time. The example
adapter uses `process.execPath` and therefore only works under an external
Node.

This packages the worker only. `launchRunner` is a Node API, and the demo
controller also needs Node. To ship an installation chain that needs no
preinstalled runtime, package the supervisor and controller dependencies too.

The bootstrap selects a compatible installer, downloads and verifies it, passes
the request, supervises settlement, then cleans temporary code. It must not contain
another swap/rollback algorithm. K provides `launchRunner` for Node callers;
there is not yet a complete product-ready shell bootstrap template.

## 1. Define the adapter and state

`createRunner` requires a HostAdapter. Supply release lookup, installation
ownership, consent policy,
notification handling and lifecycle operations through trusted build-time code.
Use `checkCompatibility(from, to)` for transitions constrained by data/protocol
compatibility. Another package manager's installation is `managed-elsewhere`.

The controller implements fence, quiesce, stop, start, healthProbe and resume, either
directly or through `createCommandHost`. Stop confirms termination; start is
idempotent; probe returns version, pid and startId from one live instance. Work
promised by quiesce must be restorable on both the candidate and rollback slots.
`fence` must confirm that earlier queued or detached controller actions cannot
later mutate the installation. `createCommandHost` drains recorded controller
processes first. Adapters with no effects surviving their worker may omit fence;
all other adapters must supply it and test it against their real service manager.
A command controller always receives `fence`; if it queues nothing, it
acknowledges. A stateless service implements `quiesce` and `resume` as
acknowledgements too. The full obligations only apply to workloads your
product promises to preserve across an upgrade.

Choose one persistent `stateDir` per installation for slots, journal and receipts.
Keep application data, installer scratch code and interpreter outside the slots.
Run the installer outside the application's service-management boundary: spawning
a child does not escape a systemd cgroup or Windows job.

## 2. Establish the initial installation

K's upgrade flow requires trusted, usable bytes in stable. For an existing
installation, a trusted setup step calls
`bootstrapStable({stateDir, version, artifactPath})` with its current executable.
This seeds a fallback; it does not authenticate/download those bytes or start a
service. It refuses conflicting state and does not overwrite initialized stable.
Fresh installation and historical-state repair remain product setup work.

The controller starts the K-selected artifact via `slotArtifactPath` or the path
provided by `createCommandHost`. Each slot contains one `artifact.bin`; package
layouts and additional install hooks need a product contract.

Promotion renames the slot directories. On Windows a running executable
locks its directory against rename, so a controller there must copy or
hard-link the artifact to a runtime path outside the slots before starting
it, and must not execute `artifact.bin` in place. On POSIX running from the
slot works because open files survive a rename, but copying keeps the
runtime path stable across promotion on every platform. The example copies
the selected artifact to `active.mjs` for both reasons (Node also needs the
extension).

K restores executables, not data migrations. Keep repair/cleanup limited to owned
installation state and provide backup/restore for destructive data changes.

## 3. Build and launch

On the build machine, bundle your trusted adapter with K:

```sh
pnpm install --frozen-lockfile
node scripts/build-runner.mjs examples/external-service/adapter.ts /tmp/k-runner.mjs
```

Follow the [example setup](../examples/external-service/README.md) before invoking
that example runner. After authenticating the caller and obtaining approval for
the target, submit a request from an operator shell or independent supervisor:

```sh
printf '%s' '{"protocolVersion":1,"action":"upgrade","id":"install-2","targetVersion":"2.0.0","consented":true}' | node /tmp/k-runner.mjs
```

`consented` records approval; it is not authorization supplied by an untrusted
network client. Requests cannot select adapter modules, commands or release URLs.
Logs go to stderr and the response to stdout. Web entrypoints need an external
launch facility and a way to retrieve the result after reconnection.

## 4. Observe and recover

Inspect both the operation outcome and exit code; the
[walkthrough](guide.md#reading-the-result) explains the two results that
surprise people, and the [reference](reference.md#protocol-v1) lists every
code.

Retry the same id/target to replay a terminal result. Use a new id for a new
attempt; there is no by-id status or archive-list action. Terminal receipts are
archived without an acknowledgement gate. Active work, corrupt state and a live
lock owner still prevent conflicting transactions. See
[receipts and retries](reference.md#receipts-and-retries).

After installer failure, run a compatible verified installer with `recover` over
the same state. Recovery needs no release lookup: before durable promote intent
it restores stable; after it, it replays commit. An external supervisor or
operator must trigger this after power loss. Never clear a lock or receipt merely
to bypass unresolved work.

Use `launchRunner` for a supervised install, or `superviseRunner` when the caller
needs a structured result. Both enforce execution/recovery deadlines and recover
only the original operation. Exit 3 leaves a verified runner and `recovery.json`;
call `resumeRunner(path)` to retry offline. Keep that directory until recovery
settles. The [example installer](../examples/external-service/install.mjs) wires
this flow. Directly invoking a worker does not supervise it.

If the whole invocation dies, start a compatible installer against the same
state; it settles unfinished work before executing a new request. A live earlier
worker still blocks takeover. Product OS startup hooks and service-unit isolation
must be validated separately; K does not install a permanent watchdog. If a
request died before its operation was recorded, bound recovery refuses rather
than guessing which earlier operation it owns. Inspect `status` and explicitly
run operator `recover` on the retained runner when current-state repair is needed.

## 5. Validate the product

Use the [test plan](test-plan.md), then test your real installer and controller on
each target platform. Cover baseline setup, running-service upgrade, bad-candidate
rollback, installer death, offline recovery, workload/data retention and service
isolation. Observe declared OS lifecycle surfaces before retiring their previous
manager. A green framework test is not product acceptance.

## Release platforms

K has no opinion about where releases come from. The adapter's ReleaseSource
answers two questions, and anything that can answer them is a release
platform as far as K is concerned:

- `checkForUpdate()`: which version should this machine move to, if any?
  Channels, cohorts, staged rollouts, pinning and version ordering all live
  behind this call.
- `fetchRelease(version)`: for exactly this version, what are the URL,
  SHA-256 and size (plus optional gzip metadata)?

The bytes can live anywhere the URL reaches: the platform itself, a CDN, or a
`data:` URL as in the example. K downloads, verifies and installs; it never
decides policy.

Common shapes, from simplest up:

| Shape | What answers the two questions | Notes |
|---|---|---|
| Static manifest on a CDN | `staticManifestSource({ baseUrl })` reads a JSON manifest you publish with each release | No server; rollout policy is whatever you write into the manifest |
| Your own release API | A small adapter mapping your API's response to a `Release` | Authentication, cohort selection and reporting are yours to build |
| [Hands](https://hands.build) | K's sibling project, the publishing side of the same loop: draft-first releases, channels and staged rollouts, share pages, in-app update metadata, feedback and crash tickets ([source](https://github.com/botiverse/hands)) | The adapter maps a Hands response to a `Release`; a launcher may obtain the installer from Hands too. Keep installer and product identities distinct |

Whatever the platform, the boundary is the same. K has no built-in connector
or result uploader for any of them. Product authentication, channel and cohort
policy and remote reporting belong to the integration. Forward the actual
operation id and outcome; publication or process launch is not installation
success, and local promotion does not prove cloud reconnection.

Withdrawing a release affects future distribution. It does not roll back already
installed machines. K can recover existing local slots offline; downloading an
older release still depends on the source authorizing and serving it.

### Optional gzip release transport

A `Release` may include a `gzip` URL, compressed size and SHA-256. K verifies
compressed bytes, bounds decompression, then checks the canonical size and hash.
Missing gzip metadata uses the canonical URL. Failure of a selected gzip object
is terminal; K does not silently switch representations. Resume offsets refer to
the compressed object.
