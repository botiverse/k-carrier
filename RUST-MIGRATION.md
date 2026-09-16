# Rust implementation and verification status

The engine, runner, supervisor, controller boundary, downloader, harness CLI and
examples are Rust. The previous implementation has been removed. K does not
require a JavaScript runtime to build, test, package or run. Documentation uses
the current Rust API; browser navigation and animated figures remain ordinary
static-site assets.

## Design preserved

The independent installer survives stopping the resident application. Two slots,
write-ahead intent, one local lock and operation-bound receipts allow interrupted
work to be settled. Real incarnation and declared lifecycle evidence authorize
promotion. Missing evidence is not success. Application data, distribution trust,
service-manager integration and workload continuity remain product obligations.

Rust traits replace executable adapter modules; native controller commands use
the v1 JSON protocol. Harness targets are explicit JSON data, while application-
specific verification integrates through Rust traits. Public language APIs have
changed; the v1 disk and wire contract remains. Fixed receipt/report/provenance
samples and native lock processes verify that contract without an archived
runtime. Removing the old implementation does not authorize dropping existing
state, receipts or recovery records.

## Evidence and boundaries

- Native runtime baseline: commit `7f4382939f15008b4218b2466db7aba2e3b74a8a`,
  [CI run 35058067719](https://github.com/botiverse/k-carrier/actions/runs/35058067719):
  macOS, Linux and Windows format, Clippy, integration suites, native walkthrough,
  256 deterministic seeds and packaged-source build all passed; Lean 4.34 passed.
- That baseline also ran direct old/new format and lock interoperability before
  the old source was removed. Current CI uses native fixed-format compatibility
  tests; the earlier interop result is historical evidence, not a current command.
- Windows testing found writable-handle flushing and inherited-pipe lifetime
  issues. Both were fixed and verified in the native walkthrough. Running images
  are copied outside slots; retired replacement images are cleaned when allowed.
- The current workflow requires all three platforms. See its run on the exact
  delivered commit for validation after documentation and archive removal.
- Elephant separately verified real launchd/systemd installation and upgrades
  across its four release targets. Its browser/enrollment integration and final
  dependency pin are separate product gates, not prerequisites for K's generic
  process protocol and not implied by the K test result.

The Lean model proves the stated transaction projection under host assumptions,
not the Rust binary, service manager or filesystem. Windows directory sync is a
no-op; physical power-loss resilience is not claimed. Product reboot hooks,
production distribution and registry publication need their own verification.

See [README.md](README.md), [examples/README.md](examples/README.md), and the
[test plan](docs/test-plan.html) for runnable commands and scope.
