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
#    The file list is asserted non-empty FIRST. Without that, a renamed directory
#    (or a find that fails) yields zero files, the loop body never runs, `missing`
#    is empty, and the ratchet reports green having examined nothing -- "looked and
#    found no violations" and "never looked" arriving at the same value. Proven:
#    pointing find at a nonexistent dir printed "ratchets: all green".
test_files=$(find core harness examples -name '*.test.ts')
if [ -z "$test_files" ]; then
  say "assertion-dichotomy ratchet found NO test files -- it checked nothing"
else
  missing=$(for f in $test_files; do
    head -5 "$f" | grep -qE "@invariant|@baseline" || echo "$f";
  done)
  [ -n "$missing" ] && { echo "$missing"; say "test file missing @invariant/@baseline header tag"; }
fi

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

# 7) docs/test-plan.md may not cite a tooth that does not exist.
#    A document naming a tooth nobody registered is worse than an omission: it
#    is more credible and equally false, and it is exactly how a test plan
#    becomes a convincing inventory of guarantees we do not have.
if ! node --experimental-strip-types -e '
import { readFileSync } from "node:fs";
const doc = readFileSync("docs/test-plan.md", "utf8");
const { allTeeth } = await import("./harness/src/teeth/registry.ts");
await import("./harness/src/teeth/index.ts");
const registered = new Set(allTeeth().map((t) => t.id));
const cited = [...doc.matchAll(/`([a-z0-9]+(?:\.[a-z0-9-]+)+)`/g)].map((m) => m[1]);
const prefixes = /^(artifact|m0|m1|m2|m3|m4|m5|m6|fake-server|fake-host|scenario|harness|examples|blackbox|artifact-factory|converge|txn)\./;
const ghosts = [...new Set(cited.filter((c) => prefixes.test(c)))].filter((c) => !registered.has(c));
if (ghosts.length) { console.log("ghost tooth ids in docs/test-plan.md: " + ghosts.join(", ")); process.exit(1); }
' 2>/dev/null
then
  say "docs/test-plan.md cites a tooth that is not registered"
fi

# 8) Docs may not cite a source file that does not exist.
#    Same failure as 7 one level down: ratchet 7 found ghost TEETH while
#    docs/test-plan.md was citing core/src/artifact/{manifest,channel}.test.ts,
#    neither of which was ever written. A named file reads as harder evidence
#    than a named tooth -- a reviewer checks a tooth list, but takes a file
#    path on faith.
#    Brace expansion in prose (a/{b,c}.test.ts) is expanded before checking,
#    or the citation form that actually appears in the docs would be skipped.
#    A path that is DELIBERATELY gone (documenting a removal) must say so on
#    the same line: "removed" / "deleted" / "删除" / "移除". The marker is the
#    exemption, so the reader sees the same thing the checker does -- an
#    exemption the checker infers silently is one the reader never learns.
#    Known limit: a line that cites a LIVE path and happens to contain one of
#    those words is exempt too, so a later deletion of that path would go
#    unflagged. Narrow enough to accept; widening the marker to a dedicated
#    token would cost every removal note a magic string.
if ! node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
const docs = readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => "docs/" + f);
const missing = [];
for (const doc of [...docs, "README.md"]) {
  const text = readFileSync(doc, "utf8");
  for (const m of text.matchAll(/`((?:core|harness|examples|scripts)\/[^`\s]+)`/g)) {
    const cited = m[1];
    const brace = /^(.*)\{([^}]+)\}(.*)$/.exec(cited);
    const paths = brace ? brace[2].split(",").map((x) => brace[1] + x.trim() + brace[3]) : [cited];
    const line = text.slice(0, m.index).split("\n").length - 1;
    const lineText = text.split("\n")[line] ?? "";
    if (/removed|deleted|删除|移除/.test(lineText)) continue;
    for (const p of paths) if (!existsSync(p.replace(/\/$/, ""))) missing.push(doc + " -> " + p);
  }
}
if (missing.length) { console.log("docs cite nonexistent paths:\n  " + missing.join("\n  ")); process.exit(1); }
' 2>&1
then
  say "a doc cites a source path that does not exist"
fi

[ $fail -eq 0 ] && echo "ratchets: all green"
exit $fail
