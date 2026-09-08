# External service example

This service has no K dependency. The external controller owns quiesce, stop,
start and same-incarnation health checks. Build a disposable helper with:

```sh
node scripts/build-runner.mjs examples/external-service/adapter.ts /tmp/k-runner.mjs
```

Run the complete disposable example (creates and cleans a temporary home):

```sh
pnpm test:runner
```

The process test bootstraps stable, starts the real HTTP service, switches to a
new process, rejects a bad candidate with rollback, kills the helper during
handoff, and recovers with a fresh helper. It writes release.json (version,
URL, SHA-256, size) and controller.mjs in its temporary K_EXAMPLE_HOME and
bootstraps k/ from trusted initial bytes via bootstrapStable. The bundled
adapter gets only this local home from the environment; it resolves no remote
code. The same preparation can be used for a manual run: set K_EXAMPLE_HOME
to that home and send protocol JSON to the helper on stdin.

This is acceptance infrastructure, not a production supervisor. Its controller
copies the selected script to active.mjs so Node treats it as ESM, then starts
it outside the helper process group. Persistent application data is separate
from the binary slots. A production controller must handle its own ownership,
authentication and process-tree semantics; localhost is not an authorization
boundary. This example listens on a random loopback port and is torn down by
the test.
