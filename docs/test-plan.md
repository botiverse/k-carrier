# Test plan

Use this plan to validate the [external runner design](design.md). The
[harness guide](harness-design.md) explains test structure and fault coverage.

## Run the checks

Node 24 and the repository's pinned pnpm are required.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:runner
node harness/src/cli.ts --list
node harness/src/cli.ts sim
node harness/src/cli.ts sim --seed 42 --json
```

`pnpm check` includes typechecking, lint, ratchets and all Node tests.
`test:runner` is a focused alternative when iterating on the external boundary,
not an extra requirement after the full suite. `--list` lists registered harness
checks; protocol and real-runner Node tests also contribute coverage.

## Acceptance criteria

| Area | Required behavior | Failure that must be detected |
|---|---|---|
| Runner acquisition | Verify helper size/hash before execution; preserve exit result and clean scratch code | Corrupt helper runs or helper failure becomes success |
| Request boundary | Validate wire version, fields, id, target and consent before loading the adapter | Invalid input reaches trusted product code |
| Ownership and policy | New upgrades respect installation owner, approved target and compatibility | Another manager's install is changed or the selected version changes after consent |
| Product acquisition | Verify exact target bytes; bound stalled transfers and validate resumed content | Corrupt, truncated or mismatched bytes reach staging |
| Transaction | Journal intent before effects; serialize operations; retain a recoverable stable slot | Conflicting writers, illegal transitions or loss of the fallback |
| Service transition | Stop old instance, start candidate, check live identity/version and declared lifecycle surfaces | Cached evidence, stale instance or wrong target authorizes promotion |
| Failure recovery | Roll back before durable promote intent; replay commit after it | A live candidate alone is treated as a committed transaction |
| Retry and receipts | Same id/target replays the recorded result; different target is rejected | Retry repeats lifecycle effects or rewrites an earlier result |
| Controller boundary | Enforce call budgets and validate response shape | Hung/failed command or malformed probe reports success |
| Workloads and data | Test the product's promised quiesce/resume and migration behavior | Rollback restores bytes but loses promised workload state |
| Observation | Preserve unreadable/absent/observed distinctions; report actual outcome | Missing data becomes success, or historical success is presented as current health |

The real-runner suite builds a helper and controls a separate service with no K
import. It covers successful upgrade, wrong-version rollback, concurrent-helper
refusal, helper death between stop and start, offline recovery and receipt replay.
Generated crash cases and seeded simulation cover mechanism-level interleavings.
Neither establishes exhaustive OS failure or physical power-cut coverage.

## Transaction completion release gate

These are required acceptance cases for the completion contract, **not a claim
that the current suite implements them all**. Existing explicit-recovery tests
are a starting point; automated supervision remains incomplete.

| Scenario | Required result |
|---|---|
| Worker exits without a durable outcome | Supervisor invokes recovery and returns the settled result, not launch success |
| Upgrade or recovery call hangs | Bounded execution; fence outstanding effects before any replacement worker |
| Worker dies but a controller action survives | No takeover until the remaining writer is stopped or safely fenced |
| Another installer starts during recovery | One state writer; original operation stays bound across retries |
| A newer operation completes before the old supervisor resumes | Old supervisor reads/replays its own result and never recovers or mutates the newer operation |
| Recovery repeatedly fails | Finite attempts and elapsed time; explicit unresolved result, retained state and executable recovery path |
| Installer starts with unfinished work | Settle it before accepting new work; do not silently retry the failed target |
| Crash during terminal reporting or cleanup | Recorded result is replayable; cleanup cannot erase required recovery state |
| Whole machine or supervisor stops | Next installer invocation restores consistency; product OS startup trigger tested separately |

Use real worker/controller processes for timeout and takeover cases, including
late effects and competing invocations. Keep generated journal-fault tests for
transaction ordering. Run both successful settlement and deliberately failed
recovery so an implementation that always returns success cannot pass.

## Maintaining test quality

- Pair success cases with failures that exercise the intended boundary.
- Keep check registrations and their known-green/known-red tests aligned.
- Test process identity and termination using real processes where those are the claim.
- Keep fixtures isolated and clean up servers, child processes and temporary state.
- Use `pnpm ratchet` to check prohibited core shortcuts, assertion declarations,
  registered-check coverage and cited source paths.

For larger deterministic runs, use
`node harness/src/cli.ts sim --start-seed 1 --seeds 50000`.
The [nightly workflow](../.github/workflows/dst-nightly.yml) runs an expanded seed
set and retains failures in `.k-harness/sim-failures.json`. Replay the reported
seed before turning a discovered failure into a fixed regression case.

## Product and platform acceptance

The [CI workflow](../.github/workflows/ci.yml) gates Linux and macOS checks;
Windows is informational while the harness port remains incomplete. A green
framework suite does not certify a product's platform support.

Before shipping an installer, test its actual packaging, installation ownership,
first-install baseline, running-service upgrade, bad-candidate rollback, recovery
while offline, workload/data preservation, and survival outside the application's
service unit. Verify cloud reconnection separately if the product promises it.
K does not supply a universal fresh-install procedure, a signed distribution
service, reversible data migrations or automatic recovery after a machine reboot.
