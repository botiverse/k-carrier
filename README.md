# K (k-carrier)

**Reliable application upgrades, run by an independent installer.**

K is for software that manages its own installation and updates, especially
services on machines where a failed upgrade would require someone to log in and
repair them. It combines a rustup-style external installer with recoverable
service upgrades.

## Why upgrading is non-trivial

Downloading a new executable is only the beginning. The application may still be
running, power may fail halfway through replacement, or the new version may fail
to start on a particular machine. Replacing the file does not prove the service
came back healthy. The installed updater may itself be too old or broken to help.

K stages verified bytes in a second slot, stops the service, starts and probes
the candidate, then commits or restores the previous executable. A durable
journal lets a subsequent installer recover interrupted work.

## One installer, multiple entrypoints

`install.sh` and your application's `self upgrade` launch the same external
installer, built from K and your product adapter. The installer owns the upgrade
transaction and exits when finished. It can be updated independently of the
application and run even when the installed application cannot start.

You distribute **three things**: the bootstrap script, the installer, and the
application release. They can share a hosting location. You supply the release
source and service lifecycle operations; K supplies the transaction machinery.

The installer must survive stopping the application. If a worker crashes,
the temporary supervisor runs bounded recovery. After reboot, an operator or OS
startup hook must start installation again. K rolls back executables,
not application data; data migration compatibility remains the product's job.
Artifact hashes check integrity; your distribution channel establishes trust.

## Get started

- [Runnable example](examples/external-service/README.md)
- [Integration and distribution guide](docs/integration.md)
- [Design and runner protocol](docs/design.md)
- [Test plan](docs/test-plan.md) and [harness design](docs/harness-design.md)
- [Prior art](docs/prior-art/design-influences.md) and [external installer research](docs/prior-art/external-runner-research.md)

Incubating · TypeScript / Node 24 · Apache-2.0. Contributions welcome.
