# Integrating K into your application

A from-zero guide. If you already know updaters, skim §2 (concepts) and jump
to your profile in §3.

## 1. What problem does K solve? (plain words)

Making a program update itself sounds trivial — download the new version,
replace the file. For a simple CLI tool, it almost is. It stops being trivial
the moment your program is a **service that keeps running**:

- You must swap the binary **under a live process** and hand control to the
  new version without dropping what it was doing.
- If the new version is broken, you need a way **back** — and "the machine
  crashed halfway through" must never leave the user with nothing runnable.
- "It updated" is easy to *claim* and surprisingly hard to *prove*. A version
  string can say `2.0` while the old process is still running, or while the
  OS still auto-starts the old copy at boot. (This exact failure — new
  version number, old behavior — is the production incident K grew out of.)
- On a **person's own machine** (not a company server), you also can't just
  change things silently: the owner decides whether upgrades are automatic,
  confirmed, or notify-only.

K packages the solutions to all of these as a library, so an app adopts them
instead of re-discovering the failure modes one incident at a time.

## 2. The concepts, in one paragraph each

**Channel** — which stream of releases you follow: `latest` (stable),
`alpha` (early), or `pinned:1.2.3` (stay put). Resolved against a static
`manifest.json` on your download server; no smart server needed.

**Two slots: `stable` and `experiment`** — K never overwrites your only copy.
The running, trusted version sits in the *stable* slot. A new version is
downloaded into the *experiment* slot and run **as a trial**. Only after it
proves itself is it *promoted* to stable; if anything fails, K *rolls back*
to the untouched stable copy. Think blue/green deployment, on one machine.

**Journal** — before K does anything (download, stop, swap, promote), it
writes what it is *about* to do to an append-only log, then does it. If the
machine dies mid-upgrade, the next start replays the journal and either
finishes the job or rolls back — decided by the log, not by guesswork. This
is why "kill it at any moment" is a test we run, not a fear.

**HostAdapter** — the small interface *you* implement so K can drive *your*
service without knowing anything about it: pause your workloads
(`quiesce`), stop/start the service, report health from the live process,
resume workloads. It's the entire integration surface — K core contains
zero concepts from any particular app.

**Predicates (proof of upgrade)** — instead of trusting a version string, K
checks two facts and calls the upgrade done only when both hold:
`binary_at_target` ("the *live process* — same PID that answered — reports
the new version") and `host_lifecycle_converged` ("OS-level state like
launch-at-login was written AND read back consistent from its one true
source"). Metadata like version fields or channel names is *banned* as
evidence — it has been wrong in the wild.

**Policy** — who decides an upgrade happens: `auto` (just do it),
`confirm` (ask the owner first), `notify-only` (tell, don't act). On
personal devices the owner always wins; even server-pushed upgrades pass
this gate.

**Install ownership** — if your binary was installed by something else (an
OS package manager, or a parent service that injects its own copy), that
manager owns upgrades. K detects this and refuses to self-upgrade a managed
copy — returning a typed `held: managed-elsewhere` instead of silently
creating a version mismatch.

## 3. Tiered adoption: start tiny, grow without switching

You do **not** need all of that on day one. K has three adoption profiles;
each is a strict superset of the previous, so an app can start at the
smallest and grow later **without changing framework**.

### Profile `cli` — any command-line tool (5 minutes)

For a program with **no resident process**, most of the hard parts vanish:
nothing to hand off, nothing to keep alive. You implement **nothing** —
there is a built-in no-op host (`NoResidentHost`, the default):

```ts
const upgrader = createUpgrader({
  releaseBase: "https://cdn.example.com/mytool",
  channel: "latest",
  rootKeys: EMBEDDED_ROOT_KEYS,
  stateDir: "~/.mytool/k",
});
// wire it to a `mytool self upgrade` subcommand:
const outcome = await upgrader.upgrade(); // effective on next run
```

You get what a `self_update`-style library gives you, **plus** the signature
chain, the crash-safe journal, and an install-provenance record — for free.
(Naming tip: if your CLI also manages *other* upgradable things, call the
command `self upgrade`, like `rustup self update` — a bare `upgrade` reads
as "upgrade the thing I manage".)

### Profile `daemon` — a resident service without hosted workloads

Now there is a live process to replace, so you implement **three real
methods** (`quiesce`/`resume` may stay no-ops):

```ts
class MyHost implements HostAdapter {
  async quiesce() {}                    // nothing to park
  async stop(slot)  { /* stop the service for that slot */ }
  async start(slot) { /* start from that slot's binaries */ }
  async healthProbe() { /* ask the LIVE process: {version, pid, startId} */ }
  async resume() {}
}
```

You get the full two-slot transaction: staged download, trial run,
promote-or-rollback, crash recovery at any point, and process-level proof
(`binary_at_target`) that the new version is actually the one running.

### Profile `managed` — hosted workloads and OS lifecycle (the full stack)

For hosts like Raft Computer — live sessions that must survive the upgrade,
plus OS state (launch-at-login, supervisors) that must converge:

- implement all five `HostAdapter` methods; `quiesce`/`resume` must satisfy
  the equivalence contract (workload state identical before/after — **also
  when resuming after a rollback**);
- register your platform's **named readback surfaces** so
  `host_lifecycle_converged` covers OS lifecycle state;
- optionally attach `drive` for server-pushed upgrades and fleet state
  readout — every remote command still passes the local policy gate.

## 3.5 Responsibility boundary: what K guarantees vs what you must

K guarantees **mechanical** properties. It cannot guarantee your
application's **semantic** compatibility across versions — and being clear
about that line is part of the contract.

| K guarantees (mechanically, with teeth) | You must guarantee (K can't see it) |
|---|---|
| the transition itself: never two incarnations live, never an unbootable host, crash at any step recovers | that version N+1 can *read* what version N wrote (your data, DB schema, caches) |
| the artifact is authentic (signature chain) and byte-complete | that N+1 speaks a protocol your server still accepts (and N does too, if you may roll back) |
| the *binary* is restorable — rollback returns the exact bytes that were running | that rolling the binary back is *meaningful* — **K restores your binary, not your data**. If N+1 migrated the user's database, rolling back to N leaves N facing N+1-shaped data |
| proof the new version is actually live and OS lifecycle converged | what `quiesce`/`resume` must preserve for *your* workloads to be intact |
| the owner's consent policy is honored | whether this upgrade is *safe to offer* at all (feature flags, in-flight work, licence state) |

**The sharpest case is rollback**, and it is the same trap as downgrade:
a rollback that restores the binary while leaving forward-migrated data
behind is not a rollback, it's a new failure. K refuses to pretend
otherwise — which is why it gives you a place to say so:

### Declare it, and K enforces it for you

Rather than leaving compatibility as a documentation promise, declare it —
K turns your declaration into a mechanical gate:

```ts
class MyHost implements HostAdapter {
  // Optional. Called BEFORE staging and BEFORE promote.
  // Return a refusal string to stop the transition; null to allow.
  async checkCompatibility(from: string, to: string): Promise<string | null> {
    if (schemaGeneration(to) > schemaGeneration(from) && !hasDownMigration(to, from)) {
      return `no down-migration from schema ${to} to ${from}`;
    }
    return null;
  }
}
```

- Refusing at **stage** time means the upgrade never starts (typed
  `held: incompatible`).
- Refusing at **promote** time means K rolls back instead of committing.
- Not implementing it is allowed — then compatibility is entirely your
  out-of-band responsibility, and K says so in `status --json`
  (`compatibility: "undeclared"`), so nobody mistakes silence for a
  guarantee.

### Invariants are shipped, not hidden

K's guarantees exist as an **exported invariant library** (`core/src/invariants.ts`),
not as private test assertions. One definition, three consumers: K's own
teeth, the deterministic simulator (checked after *every* effect, on every
seed), and **your** tests — plus any app invariants you write in the same
shape:

```ts
import { BUILT_IN_INVARIANTS, checkInvariants, type Invariant } from "@k-carrier/core";

const myAppInvariant: Invariant = {
  id: "myapp.no-orphaned-jobs",
  description: "no job is left claimed by a dead worker",
  check: (s) => (orphanCount(s) > 0 ? `${orphanCount(s)} orphaned jobs` : null),
};

const violations = checkInvariants(snapshot, [...BUILT_IN_INVARIANTS, myAppInvariant]);
```

An invariant is a pure predicate over an observable snapshot (the same
shape `status --json` emits), so the identical check runs in-process, in
simulation, and black-box against a real binary. Violations return a
*reason*, so a failure explains itself even when a simulator replays it
from a seed hours later. Your invariants ride the simulator's seeded fault
injection for free — that is the practical answer to "who guarantees my
semantics": **you state them, K's machinery exercises them.**

Rule of thumb: **K owns the mechanics of the transition; you own the meaning
of the versions.** Where you can express the meaning as a predicate, hand it
to K and it becomes enforced rather than hoped for.

## 4. The boundary in one picture

```
            YOUR APP                    |              K CORE
                                        |
  daemon ──┐                            |   ┌─ artifact (channel/download/verify/swap)
  CLI `myapp self upgrade` ──┤ construct|   ├─ distsign (2-tier signature client)
  install script ──┘    the same        |   ├─ txn (two-slot + journal + state machine)
                        ┌────────────┐  |   ├─ lifecycle (handoff orchestration)
                        │  Upgrader  │──┼──►├─ converge (predicates + readback)
                        └────────────┘  |   ├─ policy (consent/notify gating)
  your HostAdapter ◄────────────────────┼───┘  (calls back into your adapter only)
  your notificationSink ◄───────────────┘
```

One rule regardless of profile: **every entrypoint constructs the same
Upgrader.** Your daemon's auto-update loop, your CLI subcommand, your
install script — same object, same path. This kills the bug class where one
entrypoint upgrades correctly and another silently doesn't.

## 5. Publishing releases (static files only)

```
<releaseBase>/manifest.json          version, per-target {file, sha256, size}
<releaseBase>/<artifact>             the binaries
<releaseBase>/<artifact>.sig         signature per artifact
<releaseBase>/signing.pub(.sig)      rotating signing keys, root-signed
```

Root private keys stay offline; root public keys are compiled into your app.
Any static file host works — there is no server-side logic.

## 6. Testing your integration

Three beliefs shape how K is tested — knowing them explains what the harness
will and won't do with your app (full design: `harness-design.md`):

1. **Test like a user.** The primary tests spawn your *real binary* and drive
   it through its *CLI commands*, asserting from outside (exit codes, files,
   what version actually runs next). Library-level tests are the exception,
   not the rule — a green that only exists inside an import is not proof.
2. **The tests are the spec.** Every guarantee K claims (never dual-run,
   never bricked, sessions survive rollback…) exists as a registered tooth
   with a declared way to make it fail. A claim without a runnable red case
   doesn't count — that includes profile support ("K supports CLIs" is
   backed by a runnable example, not a sentence).
3. **No test backdoors.** K core contains zero test-awareness — no test
   modes, no "skip verification" flags. Everything the harness uses is a
   product surface you also get (status command, injected clock, config).
   So passing the harness means the *shipping* code path works, not a
   test-shaped variant of it.

Run the harness against **your** adapter, at your profile:

```
k-harness --profile daemon --adapter ./dist/myHost.js
```

Same teeth K tests itself with, tiered to your profile: crash-injection per
state-machine edge, quiesce/resume equivalence (including post-rollback),
probe liveness, predicate readback. Green here means your integration honors
the contract — it is the same bar the built-in examples must pass
(`examples/`: one runnable app per profile; a profile without a green
example has no support claim).
