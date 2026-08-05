#!/usr/bin/env bash
# K ratchets — mechanical bans, all fail-closed. Each violation prints file:line.
set -uo pipefail
fail=0
say() { echo "RATCHET RED: $1"; fail=1; }

# 1) Transparency (§1.8): core touches time/randomness/env ONLY via seams.
#    clock.ts is the sole file allowed to name the raw time APIs.
hits=$(grep -rnE "Date\.now\(|setTimeout\(|setInterval\(|Math\.random\(|process\.env" core/src --include='*.ts' | grep -v "core/src/clock.ts" | grep -v "\.test\.ts")
[ -n "$hits" ] && { echo "$hits"; say "raw time/random/env in core (use clock/effects seams)"; }

# 2) No test-awareness in core: no test-mode flags or unsigned backdoors.
hits=$(grep -rniE "underTest|NODE_ENV|allowUnsigned|testMode|isTest" core/src --include='*.ts' | grep -v "\.test\.ts")
[ -n "$hits" ] && { echo "$hits"; say "test-awareness string in core"; }

# 3) No any-escape hatches anywhere (xxchan: no any proliferation).
hits=$(grep -rnE "as any|: any|<any>|@ts-ignore|@ts-expect-error|@ts-nocheck" core harness examples --include='*.ts' | grep -vE ':[0-9]+:[[:space:]]*(\*|//)')
[ -n "$hits" ] && { echo "$hits"; say "any/ts-suppression escape hatch"; }

# 4) Assertion dichotomy (#395): every test file declares @invariant or @baseline.
missing=$(for f in $(find core harness examples -name '*.test.ts' 2>/dev/null); do
  head -5 "$f" | grep -qE "@invariant|@baseline" || echo "$f";
done)
[ -n "$missing" ] && { echo "$missing"; say "test file missing @invariant/@baseline header tag"; }

[ $fail -eq 0 ] && echo "ratchets: all green"
exit $fail
