# Contributing

**We do not accept code contributions (pull requests will not be merged).**

K is developed with a deliberately closed implementation loop: the test
harness is the executable specification, and design/implementation/teeth move
together under one discipline. External code — however good — can't carry
that context, so we don't merge it. (This mirrors the model of projects like
SQLite.)

**Issues are very welcome**, and are the best way to influence K:

- bug reports — ideally with a failing scenario (see `docs/test-plan.md`; a
  reproducible deterministic crash boundary is the gold standard)
- design feedback and use cases — especially "I tried to adopt profile X and
  hit Y"
- security reports — please do NOT open a public issue; contact the
  maintainers directly

Forks are of course fine under Apache-2.0.
