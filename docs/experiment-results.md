# Initial experiment results

Measured on the branch worktree with Node 24.18.0, Linux x64, and
`effect@3.22.1`. Each cold-start sample used a fresh process.

## Capability result

The vertical transaction is expressible without weakening the protocol:

- typed Journal/Clock/Slots/Source/Host/Verifier/Lock services and Layers;
- schema-checked journal reads;
- scoped lock release;
- one uninterruptible region limited to journal sync;
- definite failure rollback separated from unknown-outcome suspension;
- Promise facade and opt-in Effect-native entry over the same kernel;
- fresh-runtime recovery after every boundary observed on the successful path.

The focused suite has five tests. The crash matrix currently observes 19
boundaries and reboots after every boundary in the golden vertical path; it does
not claim the feature breadth of K 0.1.x.

## Cost result

| Measurement | Result |
| --- | ---: |
| experiment tarball, excluding dependencies | 14,925 bytes |
| `effect@3.22.1` npm unpacked size | 27,163,807 bytes / 2,715 files |
| empty Node process | 0.03 s / about 42 MiB max RSS |
| import default Promise entry | 0.46–0.47 s / about 108 MiB max RSS |
| import `/effect` entry | 0.47–0.48 s / about 108 MiB max RSS |

These are source-import measurements, not a tree-shaken production bundle.
They show the decision boundary clearly: Effect makes the kernel and harness
smaller and more compositional, but it is not a free dependency for a resident
Computer process. A production decision needs a bundled SEA measurement and an
Effect 4 migration plan, not just this source-level spike.
