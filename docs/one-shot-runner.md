# External one-shot runner

K upgrades are operations performed by a program *outside* the resident application. An installer or `self update` command is a thin bootstrap: it selects a fixed target, downloads and verifies a short-lived K runner, then executes it. The runner is never installed into either application slot, so it never needs to upgrade itself.

The runner calls `runOneShotUpgrade(upgrader, targetVersion)` and waits for the journal to reach a terminal receipt plus live readback. Exit status is mechanical: `0` means `promoted` or `up-to-date`, `1` means failure/rollback, and `2` means policy or ownership hold. “Spawned”, “accepted”, or “stopped” are never success.

The resident program exposes only the host contract: version/health probe, quiesce (stop accepting work), stop, start, and readiness. Journal, lock, slots, recovery, and rollback remain usable after the resident process exits. A bootstrap must verify runner bytes before execution and pass a fixed target; it must not silently substitute “latest” after approval. The same runner works when the old process is unhealthy because it does not call old application upgrade code.
