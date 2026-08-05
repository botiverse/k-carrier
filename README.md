# K (k-carrier)

**Self-upgrade framework for programs that must prove they came back up.** (private while incubating)

CLI self-update libraries stop at replacing bytes; fleet updaters assume a machine someone else administers. K covers what neither does: **an upgrade that is a transaction and can prove it happened** — two slots with rollback, crash-safe at every step, handoff of a live process with its workloads intact, and convergence proven from the live process and named OS surfaces (a version string is never accepted as proof). Consent and notification are built in, because on a machine someone owns personally, changing behaviour silently is not acceptable — but nothing here is limited to personal machines.

**Two process models, defined by how many live incarnations K manages** — `swap` (**0**: K replaces bytes and touches no process; a one-shot CLI and an hours-long agent session are the same case) and `service` (**1**: K stops the old, starts the new, and proves it). OS lifecycle convergence and fleet drive are capabilities you opt into on top, not a third model. Proof is executable: a runnable example per case, and a claim without a green example does not exist.

## Delivery and guarantee are different axes

Most updaters are compared on one vague axis called "complexity". There are
two, and they are independent:

|                       | delivery — how hard is it to put the bytes in place | guarantee — what is promised afterwards |
|-----------------------|---------------------------------------|-----------------------------|
| `rustup self update`  | low: replace one file, exit           | low: none                   |
| `electron-updater`    | **high**                              | low: none                   |
| **K**                 | low: one binary                       | **high**: transaction, readback, rollback |

Measured, not asserted: of electron-updater 6.8.9's ~4,200 lines, ~1,170 are
per-platform installation (Squirrel.Mac, NSIS, deb/rpm/pacman, AppImage),
~1,200 orchestration and policy, ~960 feed providers, and ~860 differential
download. Downloading is not the hard part — **installing is, because
installing is not yours to do**: you hand off to a system component with its
own rules (Squirrel.Mac accepts only a URL, so the updater serves the file it
already downloaded back to itself over a local HTTP server; NSIS may need
elevation; dpkg needs root). Grep that codebase for rollback and you find none,
and nothing checks health after the install.

K deliberately does not compete on the delivery axis — platform packaging
belongs to platform tools. It exists on the other one, and specifically for the
consequence those tools all share and none of them handle: **because something
else installs your bytes, something else replaces and restarts your process.**
The process driving the upgrade dies on the *success* path, so the successor
must be able to tell "the handover worked" from "we crashed" — by evidence,
never by a flag saying the restart was planned.

## Start here

- **[`docs/integration.md`](docs/integration.md)** — from-zero guide: the problem in plain words, concept primer, tiered adoption with code.
- [`docs/design-v1.md`](docs/design-v1.md) — full design: six layers, architecture, decision record.
- [`docs/harness-design.md`](docs/harness-design.md) — the test framework, designed first: harness as executable spec (teeth registry, real-process crash injection, adversarial self-verification).
- [`docs/test-plan.md`](docs/test-plan.md) — executable test plan (M0–M6, must-red per cell).
- [`docs/research-tailscale-datadog.md`](docs/research-tailscale-datadog.md) — the source-level survey this design stands on.

## Repo layout

```
core/       the framework — zero host-specific concepts (shells live in their
            product's repo and consume core as a dependency)
harness/    generic acceptance bed: fake-host daemon + profile-tiered teeth
examples/   one runnable demo per profile (swap-tool / service-daemon / hosted-service)
docs/       guides + design + test plan + research
```

**Platform support today:** Linux and macOS are implemented and gate CI.
Windows platform operations (replacing a *running* .exe, process liveness) are
deliberately unimplemented — they throw a typed `PLATFORM_UNSUPPORTED` rather
than approximating POSIX behaviour and corrupting an install. The Windows CI
job runs and reports, but does not gate, until those land.

Status: incubating. TypeScript first. License: **Apache-2.0**.
