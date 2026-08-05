# service-daemon — the daemon-profile example

**Proves:** the daemon profile's support claim — a long-running service
with a 3-method HostAdapter surface exercises L2 + L3 in process reality:
real spawn, real startId-bound probe evidence (same-pid + per-incarnation
startId, the #5245 anti-fake-green discipline), real stop (OS-confirmed
dead), and an atomic self-upgrade whose new version is what the next
spawned incarnation reports.

Accepted by the registered tooth `examples.service-daemon-contract` in the
daemon tier (spawn → probe → stop → verify dead → upgrade → next-run
version).

Source: `source.ts` (stamped by the artifact-factory; `K_RELEASE_BASE`
env = releaseBase config). Line protocol on stdin/stdout: `probe` →
`evidence {...}`, `exit` → graceful stop. quiesce/resume are no-ops
(daemon profile hosts no workloads).
