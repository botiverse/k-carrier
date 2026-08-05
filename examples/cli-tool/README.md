# cli-tool — the cli-profile example

**Proves:** the cli profile's support claim — a zero-dependency CLI (no
resident process, no HostAdapter) gets a verifiable self-upgrade by
declaring two commands in `k.json` (`--version` / `self upgrade`); the
upgrade is byte-atomic, sha256-verified, and effective on the next run
(L1': swap bytes = promote).

Accepted by `k-harness --bin ./cli-tool` (contract checks: version
command, self-upgrade loop with on-disk byte change + next-run version)
and by the registered tooth `examples.cli-tool-blackbox` in the cli tier.

Source: `source.ts` (stamped by the artifact-factory; `K_RELEASE_BASE`
env = releaseBase config). Commands: `greet <name>`, `--version`,
`self upgrade`.
