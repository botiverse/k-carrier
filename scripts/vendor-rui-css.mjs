#!/usr/bin/env node
// Turn raft-ui's Tailwind token layer (dist/styles.css) into plain CSS for the
// static docs site. Tailwind-only at-rules are dropped; `@theme` blocks become
// `:root` so the palette variables the theme scopes reference still resolve.
//
//   npm pack raft-ui && tar xzf raft-ui-*.tgz
//   node scripts/vendor-rui-css.mjs package/dist/styles.css docs/assets/rui.css
import { readFile, writeFile } from 'node:fs/promises';
const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error('usage: vendor-rui-css.mjs <styles.css> <out.css>');
let css = await readFile(src, 'utf8');
const version = JSON.parse(await readFile(new URL('../package.json', `file://${process.cwd()}/${src}`), 'utf8').catch(() => '{}')).version ?? 'unknown';
function dropBlock(text, opener) {
  let i = text.indexOf(opener);
  while (i !== -1) {
    let depth = 0, j = text.indexOf('{', i);
    for (; j < text.length; j++) { if (text[j] === '{') depth++; else if (text[j] === '}' && --depth === 0) break; }
    text = text.slice(0, i) + text.slice(j + 1);
    i = text.indexOf(opener);
  }
  return text;
}
css = dropBlock(css, '@custom-variant');
css = dropBlock(css, '@utility');
css = css.replace(/@theme inline \{/g, ':root {').replace(/@theme \{/g, ':root {');
const leftover = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/@(?!media|import|font-face|supports|keyframes)[a-z-]+/g);
if (leftover) throw new Error(`unhandled at-rules: ${[...new Set(leftover)].join(', ')}`);
await writeFile(out, `/* raft-ui ${version} token layer, flattened for static HTML by scripts/vendor-rui-css.mjs. Do not edit by hand. */\n${css}`);
console.log(`${out}: ${css.length} bytes`);
