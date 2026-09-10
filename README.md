# K (k-carrier)

**Reliable application upgrades, run by an independent installer.**

K is for applications you distribute yourself to end users' machines, across
operating systems, outside any package manager: desktop agents, background
services installed by `curl | sh`, CLIs that update themselves. Nobody
operates those machines. A failed upgrade means the product silently stops
working and nobody can log in to repair it. K combines a rustup-style external
installer with recoverable, verified service upgrades.

If a package manager, container image or fleet orchestrator already owns your
installation, that manager owns upgrades too. Your adapter identifies that
ownership so K can defer; you probably do not need it.

## Why upgrading is non-trivial

Downloading a new executable is only the beginning. The application may still
be running, power may fail halfway through replacement, or the new version may
fail to start on a particular machine. Replacing the file does not prove the
service came back healthy. The installed updater may itself be too old or
broken to help.

K stages verified bytes in a second slot, stops the service, starts and probes
the candidate, then commits or restores the previous executable. A durable
journal lets a subsequent installer recover interrupted work. An upgrade ends
promoted, rolled back, or explicitly unresolved with the evidence preserved;
it is never reported as a success K did not observe.

## One installer, multiple entrypoints

`install.sh` and your application's `self upgrade` launch the same external
installer, built from K and your product adapter. The installer owns the
upgrade transaction and exits when finished. It can be updated independently
of the application and run even when the installed application cannot start.

You distribute **three things**: the bootstrap script, the installer, and the
application release. They can share a hosting location. You supply the
release source and service lifecycle operations; K supplies the transaction
machinery. For the publishing side, channels, staged rollouts and in-app
update metadata, K's sibling project [Hands](https://hands.build) closes the
loop; a static manifest on any CDN works too. The runner uses Node 24, either as an external runtime or bundled
into a Node single executable. A fully runtime-independent installer must also
package its supervisor and controller dependencies.

The installer must survive stopping the application. If a worker crashes,
the temporary supervisor runs bounded recovery. After reboot, an operator or
OS startup hook must start installation again. K rolls back executables,
not application data; data migration compatibility remains the product's job.
Artifact hashes check integrity; your distribution channel establishes trust.

## Status

| Area | State |
|---|---|
| Two-slot transaction, journal, lock, receipts | Done; generated crash matrix, seeded simulation, and a Lean model of all phases, rollback and crash/recovery interleavings (host honesty assumed) |
| External runner protocol, supervisor, bounded recovery | Done; Linux/macOS process tests |
| Command controller boundary | Done; demo controller only |
| Verified download with resume and gzip | Done |
| Single-executable (SEA) runner | Verified manually; build flag provided, no CI |
| Windows | Core is platform-seamed; harness port incomplete, CI informational |
| Product-ready `install.sh` template | Not yet |
| Publisher signing of installer or release metadata | Not provided; hash and size only |
| Automatic restart after machine reboot | Not provided; product OS hook |
| Receipt archive garbage collection | Not provided |

## Documentation

Guides, written to be read in order:

- [How an upgrade works](docs/guide.md): the processes involved, one upgrade start to finish, what breaks, how to read the result
- [Runnable example](examples/external-service/README.md)
- [Integration and distribution guide](docs/integration.md)

Contracts, written to be looked up:

- [Design](docs/design.md): normative execution model, transaction, supervision and controller obligations
- [Reference](docs/reference.md): protocol, exit codes, budgets, on-disk layout
- [Test plan](docs/test-plan.md) and [harness design](docs/harness-design.md)
- [Formal model](formal/README.md)

Background:

- [Prior art](docs/prior-art/design-influences.md) and [external installer research](docs/prior-art/external-runner-research.md)

Incubating · TypeScript / Node 24 · Apache-2.0. Contributions welcome.
