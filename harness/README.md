# K harness

The generic acceptance bed runs the same registered teeth against K, a real
binary, or an adopter's HostAdapter. It also owns K's deterministic simulator.

```sh
k-harness --list
k-harness --profile service
k-harness sim                          # fixed PR smoke corpus
k-harness sim --seed 3737844653 --json # exact replay
k-harness sim --start-seed 1 --seeds 50000
```

Simulation uses the real `UpgradeEngine` over an in-memory `TxnEffects` and
HostAdapter. Every journal, slot, host and predicate effect is a seeded fault
point. A failure prints its exact replay command and is atomically merged into
`.k-harness/sim-failures.json`; the nightly workflow uploads that corpus.

The simulator covers transaction/convergence logic. It does not replace the
real-process crash matrix or real-OS test beds.
