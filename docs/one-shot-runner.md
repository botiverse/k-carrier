# K as an external upgrade framework

K executes only in a disposable external runner. Application integration and
production publication are separate from framework implementation.

[研究来源](prior-art/external-runner-research.md)

## Reading this reference

Start with the [integration guide](integration.md) for setup and ownership.
This reference specifies the runner and controller wire contracts.

## Code layout

`launcher/` downloads, verifies and executes the helper. `protocol/` defines the
shared request/response contract without process or state effects. `runner/`
serves stdin/stdout and maps requests to transaction calls. `createRunner.ts`
composes the engine, while `lifecycle/commandHost.ts` controls the application.
The transaction and artifact modules do not depend on the launcher or transport.
The root public barrel exports these functions directly, with no forwarding factory.

## The decision

An upgrade is an operation *on* a program. The owner of that operation must
survive stopping the program. K therefore supplies a disposable runner,
protocol, verified bootstrap, external host controller, and retained receipts.
The application supplies observations and lifecycle controls, not another
upgrade state machine. The runner remains usable while the application is stopped
or unhealthy, so recovery does not depend on application upgrade code.

```mermaid
flowchart LR
  I[install script] --> B[verify and launch helper]
  C[self update command] --> B
  W[Web job / external supervisor] --> B
  B --> R[disposable K runner]
  R --> K[shared K transaction engine]
  K --> D[journal + slots + receipts]
  K --> O[external host controller]
  O --> A[application stop / start / health]
```

The runner is a process outside the application slots and service process tree.
The example builds one JavaScript file requiring an independently installed
Node 24. The build contains K and a trusted application adapter. The application
binary contains **no K dependency**. Native packaging (SEA or another publisher
build system) can wrap the same entry point; this framework does not publish a native
artifact or require a permanently installed K daemon.

“Disposable” describes code lifetime, **not state lifetime**. After a helper
crash, download the helper again and send `recover`; the persisted transaction
remains. A power failure requires an external boot/supervisor hook or operator
to invoke recovery. A dead helper cannot schedule its own replacement.

## Source research and what we take from it

The source-level comparison is in [external-runner-research.md](prior-art/external-runner-research.md).
The conclusion is narrower than “copy rustup”: borrow the external executable
boundary, retain K's shared transaction engine, and explicitly preserve the
application's data compatibility and recovery obligations.

| Candidate | Consequence | Decision |
|---|---|---|
| Add a permanent K service | K needs another installed lifecycle and updater | Unnecessary for this scope |
| Fresh helper calling old app's `upgrade` | Different PID, same dependency and old gates | Rejected |
| Fresh helper + external operations adapter + durable K state | App can be stopped or broken while operations continue | Implemented |
| General package manager | Adds dependency solving, package ownership and scripts | Outside scope; delegate to the owning manager |

K covers release acquisition, integrity, transaction locking, staging, process
handoff, health evaluation, rollback and history. It does not make application
data migrations reversible, preserve sessions automatically, authenticate an
untrusted release manifest, or guarantee uninterrupted service. Application
owners implement compatibility checks before staging and idempotent
quiesce/resume for their workloads. Destructive data migrations require their
own backup/restore contract; binary rollback alone cannot reverse them.

## Runnable integration

Implement a trusted adapter returning `createRunner(options)`. This
constructs the transaction engine inside the runner; there is no second
transaction journal or parallel job state.

```sh
# Node 24 and pnpm; build the example adapter into a disposable executable.
pnpm install --frozen-lockfile
node scripts/build-runner.mjs examples/external-service/adapter.ts /tmp/k-runner.mjs
# See examples/external-service/README.md for preparing the example state.
printf '%s' '{"protocolVersion":1,"action":"status"}' | node /tmp/k-runner.mjs
```

The adapter is bound at **build time**, not selected by request JSON. Bundle it
with the helper's release and verify that artifact before executing it. A
request cannot supply code paths, arbitrary shell commands or release URLs.
Release selection/authentication and installed-directory authority remain in
the trusted adapter. Do not run an adapter received from an untrusted caller.

`launchRunner({release, request, scratchDir, interpreter?})` implements the
bootstrap: download under bounded transfer budgets, check size and SHA-256,
write into a private temporary child directory, execute, wait for exit, and
clean that directory. SHA checks integrity against the supplied manifest;
they are **not** a publisher signature. Scratch space and any interpreter must
be outside both application slots. An installer can use this API or its own
small equivalent bootstrap, but cannot add swap/rollback logic.

The subprocess helper inherits stdout/stderr and receives a request on stdin.
Use it from an operator shell or an independent supervisor. A service manager
that kills all descendants of the application will also kill a helper launched
inside that service unit; `spawn()` alone does not escape a cgroup or Windows
job. Web integration must have an external launch facility and query K state
on reconnect. K does not introduce an authenticated network API in this framework.

## Protocol v1

One JSON request on stdin, one JSON response on stdout, then process exit.
Decoded input is bounded to 16,384 JavaScript string code units. Unknown fields, actions, wire versions, empty ids,
and nonboolean consent are refused before the adapter factory runs. Adapter
logs belong on stderr; stdout is reserved for the protocol.

```json
{"protocolVersion":1,"action":"upgrade","id":"job-123","targetVersion":"2.0.0","consented":true}
```

Other requests are `{"protocolVersion":1,"action":"recover"}` and
`{"protocolVersion":1,"action":"status"}`. `consented`
represents approval already obtained by the caller, not a request to bypass
ownership or compatibility. Never derive it from an unauthenticated Web body.

| Command | Effect | Exit meaning |
|---|---|---|
| upgrade | Exactly the requested version; core rejects a source returning another | 0 promoted/up-to-date; 1 failure/rollback; 2 policy hold; 3 unresolved operation |
| recover | Settle journal under the same lock, without release lookup/download | 0 successful/no recorded outcome; 1 recorded failure/rollback; 2 held receipt; 3 still unresolved |
| status | Read the current operation, no lifecycle calls | 0 readable (inspect outcome); 1 unreadable |

Responses contain the original K `operation` and any error. Exception handling
never invents a `rolled-back` outcome. A nonzero controller exit, timeout,
process signal, missing receipt, or wrong request/target binding cannot become
successful upgrade completion. A successful **status query** is not successful
upgrade. A replay describes a historical operation, not current live health.

A response with `result: "recovered"` and an operation outcome of `rolled-back`
uses exit code 1: recovery restored stable, but the requested upgrade did not
succeed. A held receipt maps to 2. For status, exit 0 only means the receipt was
readable, including `operation.kind: "genesis"` (no recorded operation).

Successful execution replies contain `protocolVersion`, `action`, `result`,
`exitCode`, `operation` and `error`. Rejected input or adapter construction failure
may produce only `protocolVersion`, `result`, `exitCode` and `error`; clients must
not assume an operation exists on that error path. Runner termination can leave
no complete response: query status and recover the existing state as needed.

## Receipts, retry and recovery

`operation.json` holds the current operation. Before replacing a terminal receipt,
K archives it at `receipts/<sha256(operation-id)>.json` under the same upgrade lock.
Receipts record transaction outcomes, not transport delivery. There is no ACK action
or field. Active operations and corrupt state still block conflicting work.

An id binds to one target. Same-id terminal replay returns the current or archived
receipt without download or lifecycle actions; changing the target fails. After
recovery settles an interrupted id, retry returns that result. Use a fresh id for
a fresh attempt, including an approved attempt after a policy hold.

The runner checks persisted state format and receipt shape. Unreadable records
refuse before recovery begins. Missing history cannot be reconstructed. Archive
files have no automatic GC. File sync plus rename uses the platform durability
primitives; physical power-cut guarantees still depend on filesystem semantics.

## Host control contract

`createCommandHost` is the included adapter for an external controller. It uses
argv directly, never a shell; stdin contains `{protocolVersion:1, action}` and,
for start/stop, a K-selected `slot` and `artifactPath`. Stdout must be
`{protocolVersion:1,ok:true}`; `probe` additionally returns
`evidence:{version,pid,startId}`. Output is capped at 64 KiB and each command has
a positive bounded timeout (30 s default). The helper's own PID is invalid
service evidence. Controller failure messages exclude arbitrary stderr.

| Control | Application/controller obligation |
|---|---|
| quiesce | Stop admission and durably park workloads; repeated calls safe |
| stop | Stop the resident and confirm it is stopped before returning |
| start | Start specified artifact; repeated calls must not create a second resident |
| probe | Wait for readiness within budget; answer from one live incarnation, not metadata files |
| resume | Unpark work on either candidate or rolled-back stable |

If the service is already down, quiesce/stop should be idempotent; start and
probe must still work without old code. A command timeout means uncertainty,
not proof that its descendants or external effects stopped. The framework
leaves the transaction recoverable; controller implementations must fence any
asynchronous effects before a later recovery. Do not use a detached fire-and-
forget command as a successful stop.

## Failure boundaries and verification

The existing engine journals intent before stage/handoff/promote and retains
stable during candidate evaluation. Runner death during download, stop/start,
readback or terminal reporting leaves that same state for a new runner.
Before durable promote intent, recovery restores stable; after that intent,
recovery replays the commit. A bad candidate rolls back; a controller hang remains recovery-required;
unknown schemas and another live lock owner are refused.

`core/src/runner/process.test.ts` builds the helper, starts a real HTTP
service with no K import, upgrades it, verifies PID/startId/version and stable
slot, tries a hash-valid artifact reporting a wrong version, and checks actual
rollback. It kills the helper **after stop and before start**, verifies a
concurrent helper is refused, removes the distribution manifest, and recovers
with a newly launched helper. It also verifies current and archived replay,
terminal receipt preservation and id/target conflicts.

`core/src/launcher/launch.test.ts` proves mismatched helper bytes never
execute and completed helper bytes are cleaned. Protocol/runner/controller
tests cover version rejection, missing success receipt, exception evidence,
nonzero commands, malformed probes and timeout.

Linux real-process tests run locally and in the existing suite. macOS/Windows
use the existing CI/platform lanes; this framework does not claim live Computer
migration, Windows native self-delete behavior or publication of a Computer
alpha. The new example proves an external service integration, not fleet rollout.
