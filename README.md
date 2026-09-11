# K (k-carrier)

**Reliable application upgrades, run by an independent installer.**

K is for applications you distribute yourself to end users' machines, across
operating systems, outside any package manager: desktop agents, background
services installed by `curl | sh`, CLIs that update themselves. Nobody
operates those machines. A failed upgrade means the product silently stops
working and nobody can log in to repair it. K combines a rustup-style external
installer with recoverable, verified service upgrades.

K stages verified bytes in a second slot, stops the service, starts and probes
the candidate, then commits or restores the previous executable. A durable
journal lets a later installer recover interrupted work. An upgrade ends
promoted, rolled back, or explicitly unresolved with the evidence preserved;
it is never reported as a success K did not observe.

If a package manager, container image or fleet orchestrator already owns your
installation, that manager owns upgrades too; you probably do not need K.

## Documentation

**https://botiverse.github.io/k-carrier/**

The site is the plain HTML under [`docs/`](docs/), served by GitHub Pages.

- Read in order: [Overview](https://botiverse.github.io/k-carrier/),
  [How an upgrade works](https://botiverse.github.io/k-carrier/guide.html),
  [Runnable example](https://botiverse.github.io/k-carrier/example.html),
  [Integration and distribution](https://botiverse.github.io/k-carrier/integration.html)
- Contracts: [Design](https://botiverse.github.io/k-carrier/design.html),
  [Reference](https://botiverse.github.io/k-carrier/reference.html),
  [Test plan](https://botiverse.github.io/k-carrier/test-plan.html),
  [Harness design](https://botiverse.github.io/k-carrier/harness-design.html),
  [Formal model](https://botiverse.github.io/k-carrier/formal.html)
- Background: [Prior art and research](https://botiverse.github.io/k-carrier/prior-art.html)

Status, what K promises, and what an installer adds on top are on the overview page.

## Repository layout

| Path | Contents |
|---|---|
| `core/` | The transaction engine, runner protocol, supervisor and lifecycle adapters |
| `harness/` | Fault-injection harness, crash matrix and seeded simulation |
| `formal/` | Lean 4 model and proofs of the two-slot transaction |
| `examples/external-service/` | A runnable service, controller and installer |
| `scripts/` | Runner bundling, ratchets, and the docs CSS vendoring script |
| `docs/` | The documentation site |

Incubating · TypeScript / Node 24 · Apache-2.0. Contributions welcome.
