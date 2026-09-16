# Internal test fixtures

These files exercise K mechanisms and are not application integration examples.

- `cliToolSource.ts`: black-box byte replacement and artifact validation.
- `serviceSource.ts`: process startup, identity, stopping and recovery.
- `managedHost.ts`: session ledger preservation and live probe binding.
- `externalCrashAdapter.ts`: crash injection for the external runner.

Their consumers in the harness retain the existing test registrations and failure
checks. Product integration is demonstrated in
[external-service](../../../examples/external-service/README.md).
