# swap-tool — the cli-profile example

**Proves:** the cli profile's support claim — a zero-dependency CLI (no
resident process, no HostAdapter) gets a verifiable self-upgrade by
declaring its commands in `k.target.ts` (version + selfUpgrade, explicit —
the harness never guesses). The upgrade is byte-atomic, sha256-verified,
and effective on the next run (L1': swap bytes = promote).

Accepted by `k-harness --bin ./swap-tool` (contract checks: target
declaration, version command, self-upgrade loop with on-disk byte change +
next-run version) and by the registered tooth `examples.swap-tool-blackbox`
in the cli tier.

Source: `source.ts` (stamped by the artifact-factory; `K_RELEASE_BASE`
env = releaseBase config). Commands: `greet <name>`, `--version`,
`self upgrade` — declared in `k.target.ts`.
