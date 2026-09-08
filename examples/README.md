# Examples and test fixtures

Use [external-service](external-service/README.md) for application integration.
It builds a separate runner and controls an application with no K dependency.

`swap-tool`, `service-daemon` and `hosted-service` are internal engine test
fixtures consumed by the harness. Their in-process factory calls exercise
transaction and lifecycle mechanisms; they are not supported application
integration paths. Run `pnpm test` for these fixtures and `pnpm test:runner`
for the external runner protocol and real service upgrade/recovery tests.
