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

# 5) Platform assumptions stay behind the platform seam: core must not name
#    signals, process-kill, or rename-based swap outside core/src/platform/.
hits=$(grep -rnE "process\.kill|SIGKILL|SIGTERM|SIGSTOP|fs\.rename|\brename\(" core/src --include='*.ts' | grep -v "core/src/platform/" | grep -v "\.test\.ts" | grep -vE ':[0-9]+:[[:space:]]*(\*|//)')
[ -n "$hits" ] && { echo "$hits"; say "POSIX-shaped call outside core/src/platform/ (use the PlatformOps seam)"; }

# 6) Every registered tooth must be in the TOOTH_IDS of a file that runs a
#    known-green loop. The per-file COVERED_ELSEWHERE list is a CLAIM that some
#    other file exercises the tooth, and nothing verified it -- so a tooth could
#    be exempted everywhere and executed nowhere: registered, never run on a
#    clean world, free to be permanently red.
#
#    Checking "the id appears in a file that has a known-green test" is NOT
#    enough, and this was the first version's bug: the exemption list lives in
#    such a file, so every exempted tooth looked covered by its own exemption.
#    The id must be in the set that FEEDS the green loop.
if ! python3 - <<'PYCHECK'
import re, pathlib, sys

teeth_src = [p for p in pathlib.Path("harness/src/teeth").glob("*.ts") if not p.name.endswith(".test.ts")]
registered = set()
for p in teeth_src:
    registered |= set(re.findall(r'id:\s*"([a-z0-9.-]+)"', p.read_text()))

covered = set()
for p in pathlib.Path("harness/src").rglob("*.test.ts"):
    text = p.read_text()
    if "known-green" not in text:
        continue
    # any *TOOTH_IDS set in the file (m0.test.ts names its own M0_TOOTH_IDS)
    for block in re.findall(r"const \w*TOOTH_IDS\w* = new Set\(\[(.*?)\]\)", text, re.S):
        covered |= set(re.findall(r'"([a-z0-9.-]+)"', block))
    # single-tooth files declare `const TOOTH_ID = "..."` instead of a Set
    for one in re.findall(r'const \w*TOOTH_ID\w* = "([a-z0-9.-]+)"', text):
        covered.add(one)

missing = sorted(registered - covered)
if missing:
    print("uncovered: " + " ".join(missing))
    sys.exit(1)
PYCHECK
then
  say "tooth is registered but no known-green TOOTH_IDS names it"
fi

[ $fail -eq 0 ] && echo "ratchets: all green"
exit $fail
