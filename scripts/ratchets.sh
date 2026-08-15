#!/usr/bin/env bash
# K v2 experiment ratchets. Each rule is deliberately small and fail-closed.
set -uo pipefail
fail=0
say() { echo "RATCHET RED: $1"; fail=1; }

# The Promise facade must not leak Effect types into the default public entry.
if grep -nE "from ['\"]effect['\"]|Effect<|Layer<" src/index.ts; then
  say "default entry leaks Effect-native API; use the /effect entry"
fi

# Host mutations with uncertain outcomes are never automatically retried.
if grep -rnE "Effect\.retry|Schedule\.|retry\(" src --include='*.ts'; then
  say "automatic retry in durable kernel"
fi

# One clock: production code uses Effect Clock and may not invent raw timers.
hits=$(grep -rnE "Date\.now\(|setTimeout\(|setInterval\(|new Date\(" src --include='*.ts')
[ -n "$hits" ] && { echo "$hits"; say "raw time API in production source"; }

# No escape hatches in source or harness.
hits=$(grep -rnE "as any|: any|<any>|@ts-ignore|@ts-expect-error|@ts-nocheck" src harness examples --include='*.ts')
[ -n "$hits" ] && { echo "$hits"; say "any/ts-suppression escape hatch"; }

# Every test file declares whether it is a contract tooth or a baseline check.
test_files=$(find src harness examples -name '*.test.ts' 2>/dev/null)
if [ -z "$test_files" ]; then
  say "no tests found"
else
  missing=$(for f in $test_files; do
    head -5 "$f" | grep -qE "@invariant|@baseline" || echo "$f"
  done)
  [ -n "$missing" ] && { echo "$missing"; say "test file missing @invariant/@baseline"; }
fi

[ $fail -eq 0 ] && echo "ratchets: all green"
exit $fail
