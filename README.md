# K (k-carrier)

**Self-upgrade framework for programs that must prove they came back up.**

CLI self-update libraries stop at replacing bytes; fleet updaters assume a machine someone else administers. K covers what neither does: **an upgrade that is a transaction and can prove it happened** — two slots with rollback, crash-safe at every step, handoff of a live process with its workloads intact, and convergence proven from the live process and named OS surfaces (a version string is never accepted as proof). Consent and notification are built in, because on a machine someone owns personally, changing behaviour silently is not acceptable — but nothing here is limited to personal machines.

**Two process models, defined by how many live incarnations K manages** — `swap` (**0**: K replaces bytes and touches no process; a one-shot CLI and an hours-long agent session are the same case) and `service` (**1**: K stops the old, starts the new, and proves it). OS lifecycle convergence and fleet drive are capabilities you opt into on top, not a third model. Proof is executable: a runnable example per case, and a claim without a green example does not exist.

## What K owns

K does not replace platform packaging or artifact delivery. It wraps an
addressable release in a transaction with rollback and convergence readback.
Because the process driving an upgrade may die on the success path, the
successor proves the handoff from live evidence rather than trusting a flag.

## Start here

- **[`docs/integration.md`](docs/integration.md)** — from-zero guide: the problem in plain words, concept primer, tiered adoption with code.
- [`docs/design-v1.md`](docs/design-v1.md) — full design: six layers, architecture, decision record.
- [`docs/harness-design.md`](docs/harness-design.md) — the test framework, designed first: harness as executable spec (teeth registry, real-process crash injection, adversarial self-verification).
- [`docs/test-plan.md`](docs/test-plan.md) — executable test plan (M0–M6, must-red per cell).
- [`docs/prior-art.md`](docs/prior-art.md) — the source-level survey this design stands on (Tailscale / Datadog), and the license-defense record behind `NOTICE`.

## Repo layout

```
core/       the framework — zero host-specific concepts (shells live in their
            product's repo and consume core as a dependency)
harness/    generic acceptance bed: fake-host daemon + profile-tiered teeth
examples/   one runnable demo per profile (swap-tool / service-daemon / hosted-service)
docs/       guides + design + test plan + prior art
```

**Platform support today:** Linux and macOS gate CI. Windows platform
operations are implemented; its acceptance harness and CI gate are still in
progress.

Status: incubating. TypeScript first. License: **Apache-2.0**.
