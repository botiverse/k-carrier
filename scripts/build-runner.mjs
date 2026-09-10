#!/usr/bin/env node
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * Bundle a trusted adapter with K into one runner file.
 *
 * `format: "esm"` (default) produces `runner.mjs`, executed by an external
 * Node 24 interpreter. `format: "cjs"` produces the CommonJS entry that Node's
 * single-executable-application (SEA) tooling requires; see docs/guide.md.
 */
export async function buildRunner(adapter, outfile, { format = 'esm' } = {}) {
  const cli = fileURLToPath(new URL('../core/src/runner/cli.ts', import.meta.url));
  const imports = `import create from ${JSON.stringify(resolve(adapter))};\nimport {serveRunner} from ${JSON.stringify(cli)};\n`;
  const entry = format === 'esm'
    ? `${imports}process.exit(await serveRunner(create));`
    : `${imports}serveRunner(create).then((code) => { process.exitCode = code; });`;
  await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'k-runner-entry.ts', loader: 'ts' },
    bundle: true, platform: 'node', format, target: 'node24', outfile: resolve(outfile),
    ...(format === 'esm' ? { banner: { js: '#!/usr/bin/env node' } } : {}),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const cjs = args.includes('--cjs');
  const [adapter, outfile] = args.filter((a) => a !== '--cjs');
  if (!adapter || !outfile) throw new Error('Usage: node scripts/build-runner.mjs [--cjs] <trusted-adapter.ts> <runner.mjs|runner.cjs>');
  await buildRunner(adapter, outfile, { format: cjs ? 'cjs' : 'esm' });
}
