#!/usr/bin/env python3
"""Flatten a downloaded raft-ui package's token stylesheet for static HTML.

Usage: python3 scripts/vendor-rui-css.py package/dist/styles.css docs/assets/rui.css
"""
import json
import re
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit(__doc__)
source, output = map(Path, sys.argv[1:])
css = source.read_text(encoding="utf-8")
manifest = source.parent.parent / 'package.json'
version = json.loads(manifest.read_text(encoding="utf-8")).get('version', 'unknown') if manifest.exists() else 'unknown'
for opener in ('@custom-variant', '@utility'):
    while opener in css:
        start = css.index(opener)
        brace = css.find('{', start)
        if brace < 0:
            raise SystemExit('unterminated block: ' + opener)
        depth = 0
        for end in range(brace, len(css)):
            depth += (css[end] == '{') - (css[end] == '}')
            if depth == 0:
                css = css[:start] + css[end + 1:]
                break
        else:
            raise SystemExit('unterminated block: ' + opener)
css = re.sub(r'@theme(?: inline)? \{', ':root {', css)
leftovers = re.findall(r'@(?!media|import|font-face|supports|keyframes)[a-z-]+', re.sub(r'/\*.*?\*/', '', css, flags=re.S))
if leftovers:
    raise SystemExit('unhandled at-rules: ' + ', '.join(sorted(set(leftovers))))
output.write_text(f'/* raft-ui {version} token layer, flattened for static HTML by scripts/vendor-rui-css.py. Do not edit by hand. */\n' + css, encoding='utf-8')
print(f'{output}: {len(css)} characters')
