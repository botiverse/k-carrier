# Examples — one per adoption profile

**Goal (project-level, from day one): K serves every application form, not just
complex hosts.** These examples are the living proof — each profile ships a
minimal, runnable app, and CI runs the profile-tiered harness teeth against
all three. If a profile has no green example, the claim "K supports that
form" does not exist.

| Example | Profile | Shape | Demonstrates |
|---|---|---|---|
| `cli-tool/` | cli | tiny single-binary CLI, no resident process | zero-HostAdapter adoption; upgrade effective next run; signature chain + journal for free. **First real adopter: standalone raft CLI** (Computer-injected copies are `held: managed-elsewhere` by ownership detection) |
| `plain-daemon/` | daemon | small long-running service, no hosted workloads | 3-method HostAdapter; two-slot transaction, crash-safe rollback, same-PID convergence proof |
| `managed-host/` | managed | fake host with live "sessions" + an OS-lifecycle surface | full stack: quiesce/resume session preservation, named-surface lifecycle readback, policy/notification, optional drive. Shares its fake host with `harness/`. |

Status: all three demos landed — each is a runnable app accepted by the
harness (cli-tool via `k-harness --bin`, managed-host via
`k-harness --adapter`, plain-daemon via its registered tooth); the teeth
`examples.*` make each profile's claim CI-enforced. The full managed
upgrade loop (L1 two-slot + L4/L5) lands when the core upgrader wiring
does; each demo README states exactly what it proves today.
