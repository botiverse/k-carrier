# K (k-carrier)

**Upgrade framework for managed resident services on personal devices.** (private while incubating)

CLI self-update libraries solve the easy end; org-fleet updaters solve the server end. **Nobody covers the middle — a resident service on a machine a *person* owns, hosting live workloads.** K is that union: transactional two-slot upgrades with rollback, host handoff with session preservation, *proven* convergence (live-process + named-surface readback; version strings are never proof), owner consent/notification, and optional policy-gated fleet drive.

**Serves every application form, from day one** — three adoption profiles (`cli` → `daemon` → `managed`), each a superset of the last; start with a 5-minute CLI integration and grow without switching frameworks. Proof is executable: one runnable example per profile, and a profile without a green example has no support claim.

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

Status: incubating. TypeScript first. License: **Apache-2.0**.
