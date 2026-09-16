# Native examples

`native-service.rs` is a Rust application with no K dependency; it exposes a
live probe and cooperative stop on a per-incarnation loopback endpoint.
`native-controller.rs` adapts it to K's JSON controller protocol.
`native-installer.rs` bootstraps a stable slot and supervises an independent copy
of itself. `native-swap.rs` shows the smaller CLI-only atomic replacement path.

Run the complete, self-cleaning walkthrough:

```sh
python3 scripts/verify-native-examples.py
```

It builds real versions 1.0.0 and 2.0.0, serves a verified release on an ephemeral
loopback HTTP server, bootstraps the service, upgrades through a separate worker,
replays the receipt, probes the live process, and tests HTTP self replacement.
Installer invocations use `PATH=/nonexistent`. All service and identity state is
temporary and cleaned in a `finally` block.

For a product runner, replace the example environment configuration with trusted
product configuration. Compile the runner and controller, package both outside
the resident slots, and keep the release source out of untrusted JSON requests.
Native Windows controllers call `host::isolate_standard_handles` before spawning
children, so resident processes cannot inherit and keep protocol pipes open.
`serve_runner` does this automatically for workers.
The example controller is not a production service manager: it has no workload
parking or launchd/systemd integration. Implement those in the application adapter.

## External verifier declarations

`k-harness --bin ./app --target k.target.json --target-version 2.0.0` copies the
binary into an isolated sandbox and serves the supplied candidate over HTTP.
The application reads the verifier URL from `K_RELEASE_BASE`. Commands are
explicit, and a success requires changed bytes and an exact next-run version.

```json
{
  "version": ["--version"],
  "selfUpgrade": ["upgrade"],
  "artifact": "app-2.0.0"
}
```

Add a `status` argument array for `--profile service`; it must return the v1
`ProcessEvidence`, `TxnState` and `ConvergenceReport` objects. Optional `env`
contains application-specific configuration. Artifact paths are relative to the
JSON declaration. This replaces executable `k.target.ts` modules.

`k-harness --adapter ./controller --target adapter.json` exercises a controller
through the v1 protocol in a temporary cwd, with slot artifacts below `state/`.
It requires a genuinely broken candidate and checks promotion, recoverable
failure, live rollback, and refusal to probe a stopped process. Cleanup failures
fail the receipt. Use Rust `ReadbackSurface` tests for application-specific OS
lifecycle surfaces and workload invariants; this command does not invent them.

```json
{
  "stableArtifact": "service-1.0.0",
  "candidateArtifact": "service-2.0.0",
  "brokenArtifact": "service-broken",
  "stableVersion": "1.0.0",
  "targetVersion": "2.0.0",
  "args": []
}
```
