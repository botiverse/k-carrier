# Integrating K into your application

A from-zero guide. If you already know updaters, skim §2 (concepts) and jump
to your profile in §3.

## 0. The premise (read this first)

**K assumes restarting your service is not expensive.** It guarantees you
**come back up** — not that you never went down. A short interruption during a
version change is accepted by design; what K refuses to accept is an upgrade
that leaves you unrunnable, half-migrated, or claiming success it cannot prove.

If you need strict continuous availability, **K is the wrong tool** — better
said here than discovered from behaviour later.

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

**Release source** — the one place K asks *your* product two questions:
"what should this install be on?" (`checkForUpdate`) and "give me exactly
this version" (`fetchRelease`). K holds **no versioning policy of its own** —
what your streams are called ("stable", "nightly", "lts-2024"), which version
counts as newest, whether you use semver or dates, and long-term pinning all
live inside your source. A ready-made `staticManifestSource({ baseUrl })` covers
the common case (static host, semver, no automatic downgrade) as *one policy*,
not as a rule of the framework.

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

## 3. Adoption: two process models, plus capabilities you opt into

A profile is a **process model**, and the model is defined by one number:
**how many live incarnations K itself manages.**

| Profile | K-managed live processes | Who hands over | Examples |
|---|---|---|---|
| **`swap`** | **0** | nobody — new bytes take effect on the next start | a one-shot CLI, `rustup`, **and a long-running interactive session like Claude Code** |
| **`service`** | **1** (briefly 0 mid-handover) | K stops the old, starts the new, and proves it | a resident daemon, Raft Computer |

That a quick CLI and an hours-long agent session share a profile is surprising
at first and correct on reflection: **neither has a process K hands over.**
Several old-version processes may keep running in the `swap` model — normal,
and invisible to K.

There is **no third model**. OS lifecycle convergence
and fleet drive are **capabilities** you opt into on top of `service`; bundling
them into a "profile" confused *what your app does* with *what K does*, and
what your app does is none of K's business.

```ts
// a service that also wants its sessions preserved and its OS lifecycle proven
createUpgrader({ host, source, policy: "auto", /* ... */ });
// capabilities are declared by implementing the corresponding host duties:
//   named readback surfaces        -> lifecycle-convergence
//   attach the drive module        -> fleet-drive
```

## 3.5 Responsibility boundary: what K guarantees vs what you must

K guarantees **mechanical** properties. It cannot guarantee your
application's **semantic** compatibility across versions — and being clear
about that line is part of the contract.

| K guarantees (mechanically, with teeth) | You must guarantee (K can't see it) |
|---|---|
| the transition itself: never two incarnations live, never an unbootable host, crash at any step recovers | that version N+1 can *read* what version N wrote (your data, DB schema, caches) |
| the artifact is byte-complete (sha256 + size) — **authenticity is NOT checked; see §Trust** | that N+1 speaks a protocol your server still accepts (and N does too, if you may roll back) |
| the *binary* is restorable — rollback returns the exact bytes that were running | that rolling the binary back is *meaningful* — **K restores your binary, not your data**. If N+1 migrated the user's database, rolling back to N leaves N facing N+1-shaped data |
| proof the new version is actually live and OS lifecycle converged | what `quiesce` must park durably, and what `resume` must bring back |
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
import { BUILT_IN_INVARIANTS, checkInvariants, type Invariant } from "@botiverse/k-carrier";

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
  daemon ──┐                            |   ┌─ artifact (download/resume/verify/swap)
  CLI `myapp self upgrade` ──┤ construct|   ├─ (no signature client — see §Trust)
  install script ──┘    the same        |   ├─ txn (two-slot + journal + state machine)
                        ┌────────────┐  |   ├─ lifecycle (handoff orchestration)
                        │  Upgrader  │──┼──►├─ converge (predicates + readback)
                        └────────────┘  |   ├─ policy (consent/notify gating)
  your HostAdapter ◄────────────────────┼───┤
  your notificationSink ◄───────────────┼───┤
  your onProgress ◄─────────────────────┼───┘  (calls back into your code only)
```

One rule regardless of profile: **every entrypoint constructs the same
Upgrader.** Your daemon's auto-update loop, your CLI subcommand, your
install script — same object, same path. This kills the bug class where one
entrypoint upgrades correctly and another silently doesn't.

## 4.5 Showing progress

Pass `onProgress` and K reports where an upgrade is:

```ts
createUpgrader({
  ...,
  onProgress: (p) => {
    // p.stage: checking | downloading | verifying | staging
    //        | handing-over | probing | promoted | rolled-back
    // p.downloaded / p.total: bytes, present during `downloading` only
    render(p);
  },
});
```

Three things worth knowing before you draw a bar with it:

- **Only `downloading` has a denominator.** Every other stage reports a
  stage and nothing else, because K does not know how long staging or
  probing will take and will not invent a number.
- **`downloaded` counts bytes on disk, not bytes fetched this attempt.** A
  resumed download starts at the size of the partial file. That is deliberate:
  a bar that restarts from zero after a network blip reads as "it lost my
  download".
- **Your sink cannot fail the upgrade.** K calls it inside a `try`/`catch`
  and discards anything it throws. An observation surface must never become
  a failure mode — if your renderer breaks, the upgrade still completes.

Artifact transfer has three independent fail-closed budgets. Response headers
must arrive promptly, body progress must not go silent, and the full transfer
has a hard ceiling derived from the release source's declared byte size. The
defaults accept a Computer-sized binary that takes longer than ten seconds
while still bounding an unreachable server and a wedged mid-body stream. An
adopter with stricter network requirements may provide all four policy fields:

```ts
createUpgrader({
  ...,
  artifactTransferPolicy: {
    responseTimeoutMs: 20_000,
    idleTimeoutMs: 30_000,
    minimumBytesPerSecond: 128 * 1024,
    maximumOverallTimeoutMs: 20 * 60_000,
  },
});
```

The total budget is `responseTimeoutMs + size / minimumBytesPerSecond`, capped
by `maximumOverallTimeoutMs`. Invalid, zero, or effectively unbounded policies
are rejected before the byte request starts.

The stages are not a parallel state machine: they are derived from the L1
transaction phases (`stageForPhase`), so a progress display can never show a
state the transaction does not have.

## 4.6 One durable operation receipt

When a host detaches the transaction driver from the service it replaces,
pass an exact operation descriptor to `upgradeTo`. K then owns the only
durable operation state, including the previous stable version and terminal
outcome:

```ts
await upgrader.upgradeTo("2.0.0", {
  consented: true,
  operation: {
    id: requestId,
    startedAtMs: Date.now(),
    metadata: { originServerId }, // non-secret host correlation only
  },
});

const receipt = await upgrader.operation();
if (receipt.kind === "observed" && receipt.operation.outcome !== null) {
  await deliver(receipt.operation);
  await upgrader.acknowledgeOperation(receipt.operation.id);
}
```

The host may project this receipt into UI or transport, but must not maintain
a second pending/status/previous-version state machine. `recover()` settles an
active receipt under K's upgrade lock before the host reads it again. A corrupt
or future-version receipt is `unreadable`, never treated as genesis or success.

## 5. Publishing releases

If you use the built-in `staticManifestSource`, its layout is:

```
<baseUrl>/manifest.json          version, per-target {file, sha256, size}
<baseUrl>/<artifact>             the binaries
```

Root private keys stay offline; root public keys are compiled into your app.
Any static file host works — there is no server-side logic.

**This layout belongs to that source, not to K.** Publishing from a private
API, date-stamped paths, or an OCI registry means writing your own
`ReleaseSource`; K only ever learns `{ version, url, sha256, size }` and never
parses a manifest itself. Multiple streams are usually one base URL each
(`.../stable`, `.../nightly`), which also keeps their blast radius separate.

### Trust: what K checks, and what it does not

**K verifies integrity, not authenticity.** It checks `sha256` + `size` on the
assembled bytes. It does **not** verify who produced them: there is no
signature chain and no trust root (removed 2026-08-06 — `docs/design-v1.md`
§L0.5 has the decision).

A digest is not a signature. `sha256` proves the bytes you received are the
bytes the manifest described — but the manifest comes from the same place the
bytes do, so a source serving malicious bytes will serve a matching digest for
them just as happily.

⚠️ **So this is yours to think about, not K's:**

| Threat | Covered by K? |
|--------|---------------|
| corruption in transit | ✅ (and your HTTPS already covers it) |
| a wrong artifact on your CDN — leaked publish credentials, misconfigured bucket, poisoned pipeline | ❌ **not covered** — the check passes and every client installs |

**OS code signing is a different guarantee, not a substitute.** Authenticode /
codesign / notarization answer "is this program signed by a recognisable
vendor", enforced by the OS on the install paths it controls. A distribution
signature answers "**is this the exact artifact we published**", enforced by
your app before the bytes reach a slot. If you ship through an app store or a
platform installer you get some of the former for free; if you ship a plain
binary from a CDN, as the example host does, you get neither automatically.

If you need authenticity today, do it in your own `ReleaseSource`: verify
before returning the `Release`, and refuse rather than return unverified bytes.
⚠️ And if you build it, remember the trap this project already hit: **"accept
unsigned" may only be declared by YOUR code, never by a field in the manifest**
— the manifest is served by the very party a signature chain exists to distrust.

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
k-harness --profile service --adapter ./dist/myHost.js
```

Same teeth K tests itself with, tiered to your profile: crash-injection per
state-machine edge, quiesce/resume equivalence (including post-rollback),
probe liveness, predicate readback. Green here means your integration honors
the contract — it is the same bar the built-in examples must pass
(`examples/`: one runnable app per profile; a profile without a green
example has no support claim).
