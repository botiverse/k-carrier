# K reference

Normative wire formats, exit codes, budgets and on-disk layout. This document
is a contract: it states what K does and requires, not why. For the
reasoning, read the [design](design.md); for a narrative, the
[guide](guide.md).

## Protocol v1

One JSON request on stdin, one response on stdout, then exit. Logs go to
stderr. Decoded input is bounded to 16,384 JavaScript string code units.
Unknown fields, actions or protocol versions, invalid ids or targets, and a
nonboolean `consented` are rejected before the adapter factory runs.

Request ids and target strings are nonempty, trimmed strings of at most 256
code units.

### Requests

```json
{"protocolVersion":1,"action":"upgrade","id":"job-123","targetVersion":"2.0.0","consented":true}
{"protocolVersion":1,"action":"recover"}
{"protocolVersion":1,"action":"recover","expected":{"id":"job-123","targetVersion":"2.0.0"}}
{"protocolVersion":1,"action":"status"}
```

`consented` records approval already obtained by an authenticated caller. It
is not authorization from an untrusted client. Ownership and compatibility
checks still apply.

`expected` binds automated recovery to one operation. The binding is checked
under the lock before any controller action. Missing or mismatched history
refuses recovery. A completed original operation replays its result even when
newer work is pending. An operator `recover` without `expected` runs once
against the current unfinished operation.

### Actions and exit codes

| Action | Effect | Exit code |
|---|---|---|
| `upgrade` | Install the exact requested version; a mismatched source result is rejected | 0 promoted or up-to-date; 1 failure or rollback; 2 held; 3 unresolved |
| `recover` | Settle persisted work under the same lock; never starts a new upgrade | 0 successful or no recorded outcome; 1 recorded failure or rollback; 2 held receipt; 3 unresolved |
| `status` | Read the current receipt without lifecycle calls | 0 readable, including `genesis`; 1 unreadable |

### Responses

Execution replies carry `protocolVersion`, `action`, `result`, `exitCode`,
`operation` and `error`. Input rejection or adapter-construction failure may
return only `protocolVersion`, `result`, `exitCode` and `error`. Termination
can leave no complete response; inspect persistent state and recover.

`operation.kind` is `observed` (with the operation record), `genesis` (no
operation recorded) or `unreadable`.

Rules:

- A successful upgrade completion must match the request id and target.
- Exceptions cannot manufacture a rollback receipt.
- `status` exit 0 means readable; it does not prove current health.
- `recover` can return `result: "recovered"` with exit 1 after restoring
  stable and recording a rolled-back upgrade.
- A supervisor that cannot settle returns `result: "recovery-required"`, exit
  3, and a `recoveryFile` path.

## Receipts and retries

`operation.json` holds the current operation. Before starting another, K
archives a terminal receipt at `receipts/<sha256(operation-id)>.json` under
the same lock. Archived receipts have no automatic garbage collection.

- An id binds to one target. A same-id terminal retry returns the current or
  archived result without repeating lifecycle effects; a different target for
  the same id is rejected.
- Recovery settles the interrupted operation, so retrying its id returns
  that outcome.
- A new attempt, including one after a policy hold, needs a new id.
- Replayed results are historical, not live observations.
- Receipt retention is independent of transport delivery.
- Unreadable records refuse operations; missing history cannot be
  reconstructed.
- `status` reads the current receipt only. There is no by-id status or
  archive-list action.

## Supervisor budgets

| Budget | Default | Option |
|---|---|---|
| Worker execution | 10 minutes | `executionTimeoutMs` |
| Each recovery attempt | 2 minutes | `recoveryTimeoutMs` |
| Recovery attempts | 2 | `recoveryAttempts` (0 to 10) |
| Total | execution + 2 × recovery (14 minutes) | `totalTimeoutMs` |
| Exit observation after termination | 1 second | fixed |

All budgets are positive integers. Artifact acquisition has separate transfer
budgets derived from the artifact size (`artifactTransferPolicy`). An
unconfirmed worker exit forbids takeover. Exhaustion preserves state and
returns exit 3 with a recovery file; it never reports success.

## Engine host-call budget

Every host call, including fence, readback, resume and recovery, has a
positive budget, default 120 seconds (`hostCallBudgetMs`). A call whose
effect is uncertain raises `HostCallUncertain`; the worker retains its lock
until it exits. Bundled workers exit after flushing their response. An
in-process caller that receives `HostCallUncertain` must also exit rather
than reuse that worker.

## Command controller protocol

`createCommandHost({stateDir, command, timeoutMs?})` runs an external
controller via argv, without a shell.

Request on stdin:

```json
{"protocolVersion":1,"action":"fence"}
{"protocolVersion":1,"action":"quiesce"}
{"protocolVersion":1,"action":"stop","slot":"stable","artifactPath":"<stateDir>/slots/stable/artifact.bin"}
{"protocolVersion":1,"action":"start","slot":"experiment","artifactPath":"<stateDir>/slots/experiment/artifact.bin"}
{"protocolVersion":1,"action":"probe"}
{"protocolVersion":1,"action":"resume"}
```

Response on stdout:

```json
{"protocolVersion":1,"ok":true}
{"protocolVersion":1,"ok":true,"evidence":{"version":"2.0.0","pid":4242,"startId":"..."}}
```

Rules:

- Output is bounded to 64 KiB. Each call has a positive timeout, default 30
  seconds.
- A controller must do nothing without a complete request.
- `probe` evidence must come from one live service instance. The controller
  process's own pid is invalid evidence.
- Reported errors exclude arbitrary stderr.
- Before delivering a command, the host durably records the controller pid in
  a unique file under `controllers/`. Recovery waits for recorded controllers
  to exit, then calls `fence`. Failure or timeout there prevents lifecycle
  replay. The recorded pid is never used to kill an arbitrary process; pid
  reuse or inaccessible identity yields a conservative unresolved result.
- `fence` acknowledgement is a product contract. K cannot infer it from
  process exit. A fire-and-forget `stop` cannot establish termination.

## Lock protocol

`upgrade.lock` has one live owner per state directory. Unique process-owned
contender entries serialize creation and reclamation, including the
partial-write window. Only entries of provably dead owners are reclaimed. Pid
reuse conservatively refuses acquisition; age never proves that a live owner
is dead. The protocol requires local atomic file creation and coherent
directory reads. It is not a distributed or NFS lock.

## State directory layout

```text
<stateDir>/
  upgrade.lock            live owner
  upgrade.lock.claims/    contender entries
  journal.jsonl           append-only write-ahead phase record, fsync'd per line
  operation.json          current operation receipt
  receipts/<sha256(id)>.json
  slots/stable/artifact.bin
  slots/stable/VERSION
  slots/experiment/artifact.bin
  slots/experiment/VERSION
  incoming/               staging for verified downloads before slot placement
  controllers/            recorded controller pids
```

Each slot holds one `artifact.bin` and its `VERSION`. Package layouts and
additional install hooks need a product contract. Application data belongs
outside the slots. `status` reads `operation.json` without taking the lock.

## Supervisor scratch layout

```text
<scratchDir>/k-runner-<random>/
  runner.mjs | runner.bin   verified runner (mode 0700)
  recovery.json             invocation descriptor: file, interpreter, sha256, size, recover request
```

`recovery.json` is an invocation descriptor, not a transaction log. It is
removed after settlement and retained on an unresolved result.
`resumeRunner(path)` re-verifies the runner against the recorded hash before
executing it.

## Release metadata

```json
{"version":"2.0.0","url":"https://.../service","sha256":"<hex>","size":123456,
 "gzip":{"url":"https://.../service.gz","sha256":"<hex>","size":45678}}
```

`sha256` and `size` always describe the installed bytes. When `gzip` is
present K downloads and verifies the compressed object, bounds
decompression, then verifies the canonical size and hash. Failure of a
selected gzip object is terminal; K does not fall back to the canonical URL.
Resume offsets refer to the compressed object.
