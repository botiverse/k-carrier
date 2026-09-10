# Prior art and design influences

K draws on existing installer designs. This directory records the ideas and their
limits; it is not a claim that K supersedes every updater or that another project
lacks a feature. The original surveys used upstream source snapshots or moving
`main` links and were not exhaustive product audits. Attribution is summarized
in [NOTICE](../../NOTICE).

| Source | Idea used in K | Boundary |
|---|---|---|
| [Rustup](https://github.com/rust-lang/rustup) | Thin bootstrap and an installer that can execute independently of the installed program | Helper code still has a version, trust requirements and platform-specific replacement constraints |
| [Tailscale clientupdate](https://github.com/tailscale/tailscale/tree/main/clientupdate) | Respect installation ownership; distinguish replacing bytes from restarting the service | K uses an external runner; it does not embed the transaction in the application daemon |
| [Datadog installer](https://github.com/DataDog/datadog-agent/tree/main/pkg/fleet) | Stable/experiment slots with promotion and rollback | K does not adopt a package catalog, permanent installer daemon or fleet control plane |
| [Tailscale distsign](https://github.com/tailscale/tailscale/tree/main/clientupdate/distsign) | A studied example of distribution authentication | K currently checks SHA-256 and size, not publisher signatures; no signing roadmap is implied |

The [external installer research](external-runner-research.md) gives source links
and explains the execution-boundary decision. K's supported contract is defined
by its [design](../design.md), not by feature comparisons with other projects.

The original test survey also informed table-driven platform tests and observing
events after a known marker. K adds its own fault injection, seeded simulation
and real-runner tests; these do not establish exhaustive platform reliability.
See the [harness guide](../harness-design.md) for what each layer proves.

These are conceptual influences. The project's attribution record states that
no upstream implementation code was copied.
