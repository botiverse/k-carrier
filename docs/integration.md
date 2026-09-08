# Integrating K with an application

Build a disposable external runner containing K and a trusted application adapter.
The application exposes lifecycle and health controls; it does not execute K.
The [design](design-v1.md) defines this execution boundary and the
[runner protocol](one-shot-runner.md) specifies requests and results.

## 1. Define the application contract

Choose `swap` when K only replaces bytes, or `service` when it manages a resident.
For service mode, implement quiesce, stop, start, healthProbe and resume through
an external controller. Stop must confirm termination; start must be idempotent;
probe must return version, pid and startId from one live incarnation. Quiesce and
resume must preserve the workloads you promise to preserve, including rollback.

Declare installation ownership, consent policy, notification sink and a trusted
ReleaseSource. A package-manager-owned installation must report managed-elsewhere.
Implement `checkCompatibility(from, to)` when application data or protocol changes
can make a transition unsafe. K restores binaries, not application data; provide
backup/restore independently for destructive migrations.

## 2. Build the runner

Use `createExternalUpgrader(options)` inside the trusted adapter, as shown in
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

## 3. Launch from outside the application

Keep runner code and scratch space outside both application slots. Launch it from
an operator shell or external supervisor that survives stopping the application.
Spawning a child inside the application's service unit does not establish isolation.
An installer may use `execOneShotRunner` to download, verify, execute and clean the
helper; it must not implement its own swap or rollback logic.

```sh
printf '%s' '{"protocolVersion":1,"action":"upgrade","id":"install-2","targetVersion":"2.0.0","consented":true}' | node /tmp/k-runner.mjs
```

Only pass `consented: true` after the launcher's authenticated caller has approved
the operation. Logs go to stderr; stdout is reserved for the response. A Web UI
needs an external launch facility and queries the durable result after reconnect.

## 4. Observe, retry and recover

Read the response's operation and exit code. A completed status query does not
prove a successful upgrade. Same-id/same-target retry returns the stored result;
it never re-executes the transaction. Use a new id for a new attempt.

Terminal receipts archive automatically before replacement. There is no delivery
confirmation action or gate. Active operations, unreadable state and live lock
owners still prevent starting a conflicting transaction.

After runner failure, launch a verified runner and submit `recover`. It settles
persisted work without release lookup: before durable promote intent, restore
stable; after that intent, replay the commit. The launcher or external supervisor
owns restarting recovery after power loss. Never infer completion from process
spawn alone or bypass the lock to clear an unresolved result.

## 5. Verify application behavior

Run `pnpm check` and the external process tests, then test your actual controller
on each supported platform. Verify stop/start, one-incarnation readiness, broken
candidate rollback, runner death between stop and start, and recovery with the
release source unavailable. Check workload restoration and application data
compatibility independently. If you declare OS lifecycle surfaces, read them back
before retiring their previous manager; undeclared observations are not passes.

The other repository examples and harness modules exercise internal engine
mechanisms. They are test fixtures, not alternate application integration paths.
