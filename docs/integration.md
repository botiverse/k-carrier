# Integrating carrier into your application

The adopter's view: what you implement, what you call, what you deploy, what you get. Core never learns your internals; you never re-implement upgrade logic.

## The boundary in one picture

```
            YOUR APP                    |            CARRIER CORE
                                        |
  daemon ──┐                            |   ┌─ artifact (channel/download/verify/swap)
  CLI `myapp upgrade` ──┤ constructs    |   ├─ distsign (2-tier signature client)
  install script ──┘    the same        |   ├─ txn (two-slot + journal + state machine)
                        ┌────────────┐  |   ├─ lifecycle (handoff orchestration)
                        │  Upgrader  │──┼──►├─ converge (predicates + readback)
                        └────────────┘  |   ├─ policy (consent/notify gating)
  your HostAdapter ◄────────────────────┼───┘  (calls back into your adapter only)
  your notificationSink ◄───────────────┘
```

## Step 1 — implement `HostAdapter` (the only required work)

Five methods (`core/src/lifecycle/hostAdapter.ts`):

```ts
class MyHost implements HostAdapter {
  async quiesce()      { /* park workloads durably (sessions, jobs) */ }
  async stop(slot)     { /* stop service tree for that slot */ }
  async start(slot)    { /* start service from that slot's binaries */ }
  async healthProbe()  { /* ask the LIVE process: {version, pid, startId} */ }
  async resume()       { /* un-park workloads; must also work post-rollback */ }
}
```

Contract you must honor (the harness verifies these against your adapter):
- workload state before `quiesce()` == after `resume()` — **including when
  `resume()` runs on the rolled-back stable slot**;
- `healthProbe()` evidence comes from one live process (pid + startId), not
  from files or caches.

## Step 2 — construct the `Upgrader` from EVERY entrypoint

```ts
const upgrader = createUpgrader({
  host: new MyHost(),
  releaseBase: "https://cdn.example.com/myapp",
  channel: "latest",                     // or "alpha" / "pinned:1.2.3"
  policy: "confirm",                     // "auto" | "confirm" | "notify-only"
  notificationSink: (e) => myUi.show(e), // consent prompts + failure notices
  rootKeys: EMBEDDED_ROOT_KEYS,          // compiled into your binary
  stateDir: "/var/lib/myapp/carrier",
});
```

Rule: your daemon's auto-update loop, your `myapp upgrade` CLI command, your
install script's post-install step — **all construct this same Upgrader**.
One canonical executor; there is no entrypoint that swaps bytes but skips
convergence. (This kills the "installer converges but `upgrade` doesn't"
bug class — the exact production incident that motivated this framework.)

```ts
const outcome = await upgrader.upgrade();
// { result: "promoted", report }        — proven: predicates passed
// { result: "rolled-back", reason }     — automatic; stable restored + resumed
// { result: "held", reason }            — policy or fail-closed hold, typed
// { result: "up-to-date" }
```

## Step 3 — publish releases (static files only)

No smart server required:

```
<releaseBase>/manifest.json          version, per-target {file, sha256, size}
<releaseBase>/<artifact>             the binaries
<releaseBase>/<artifact>.sig         distsign signature per artifact
<releaseBase>/signing.pub(.sig)      rotating signing keys, root-signed
```

Root private keys stay offline; root public keys are compiled into your app
(rotation = ship a release with an added root, then retire the old one).

## Step 4 — (optional) platform surfaces and fleet drive

- If your service has OS-lifecycle state (launch-at-login, OS supervisor
  entries), register the platform adapter's **named readback surfaces** so
  `host_lifecycle_converged` covers them. Fail-closed retirement of legacy
  managers comes for free.
- If you want server-driven upgrades, attach the `drive` module: your server
  pushes stage/promote/rollback commands and reads per-machine
  `{stable, experiment, predicates, policy}` state. Every remote command
  passes the local policy gate — the device owner always wins.

## What you get without writing it

- crash-safe transactional upgrade with automatic rollback (kill -9 at any
  step: recovers to stable or completes — never dual-run, never bricked)
- signature chain (offline roots → rotating keys → artifacts)
- proven convergence (predicates + live-process evidence; version strings
  banned as proxies)
- consent/notification with a test-verified delivery path
- install-provenance journal (who reconciled this machine, when, via what)

## Testing your integration

Run the harness suite against YOUR adapter (not just the built-in fake host):

```
k-harness --adapter ./dist/myHost.js
```

Same teeth the framework tests itself with: crash-injection per state-machine
edge, quiesce/resume equivalence (including post-rollback), probe liveness,
predicate readback. Green here = your integration honors the contract.
