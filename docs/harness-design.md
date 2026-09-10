# Harness design

The harness tests K's transaction mechanisms. The external runner tests exercise
application integration. Neither replaces acceptance tests for a product's actual
service manager, installer packaging and data.

## Test layers

| Layer | Implementation | Evidence |
|---|---|---|
| Mechanisms | Core unit tests, harness checks, injected effects | Locking, journal ordering, slots, policy, rollback and convergence |
| Execution boundary | Protocol, launcher, runner and command-controller tests | Input rejection, verified runner execution, bounded calls, receipt and exit-code binding |
| Real processes | `core/src/runner/process.test.ts` | A separate runner upgrades an application with no K dependency; another worker recovers after a crash |
| Product acceptance | Product repository and target machines | Real service isolation, packaging, workload restoration and data compatibility |

`pnpm test` runs the first three layers; `pnpm test:runner` selects the runner
boundary and integration tests. Direct Node tests are not all registered harness
checks, so `--list` is not the complete test inventory.

## Components

All paths below are under `harness/src/`.

| Directory | Role |
|---|---|
| `fake-host/` | In-process hosts and spawned service processes with controllable faults |
| `fake-server/` | Local artifact delivery, range requests and corrupted responses |
| `artifact-factory/` | Runnable, version-stamped fixture artifacts with selectable failures |
| `fixtures/` | Internal byte-replacement, service and workload-ledger fixtures |
| `scenario/` | Isolated sandboxes and virtual time |
| `crash/` | Transition-derived fault matrix and recovery assertions |
| `sim/` | Seeded fault scheduling, invariant checks and replayable failure records |
| `teeth/` | Named checks, selection and known-green/known-red tests |

Core receives host, source, clock and effects through normal interfaces. It must
not detect tests or gain test-only bypasses. Logical tests use virtual time;
process/network tests use bounded waits and clean up their resources.

## Registered checks

A registered check (called a *tooth* in the code) declares its id, tested layers,
profile, invariant or baseline failure condition, and a mutation that must fail.
The registry rejects invalid declarations and duplicate ids. Known-green cases
establish that correct behavior passes; known-red and adversarial cases establish
that the check catches its intended failure. A declared mutation is not evidence
that a separate mutation campaign has run.

The harness profiles `swap` and `service` select mechanism checks. Internal
fixtures invoke the engine directly; product examples use the external runner.

`--adapter` runs the subset supported by a harness adapter's declared contract;
it expects the harness driver interface, not an arbitrary product HostAdapter.
`--bin` drives a fixture or binary through explicitly declared commands in
`k.target.ts` (or `--target`). Missing command declarations fail; the harness does
not infer CLI names. See `node harness/src/cli.ts --help` for current options.

## Fault coverage and limits

The crash enumerator crosses the transaction transition table with three points:
before journal write, after journal write and after the action. The matrix uses
injected effects and simulated crashes. Directed real-process tests separately
kill a worker between stop and start and verify recovery. The generated matrix
is not a claim that every point was tested with OS kills or physical power loss.

Seeded simulation explores additional effect interleavings. Its receipts preserve
the seed and transcript hash; failing seeds are saved for replay. Regressions
should become fixed cases. Simulation does not establish filesystem durability,
service-manager isolation or platform-specific executable replacement.

Recovery uses the same contract at every layer: before durable promote intent,
restore stable; after it, replay commit. Product controllers must also isolate
unfinished asynchronous effects before retrying a timed-out operation.

See the [test plan](test-plan.md) for commands and acceptance criteria, and the
[design](design.md) for the transaction and wire contracts.
