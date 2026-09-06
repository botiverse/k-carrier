#!/usr/bin/env node
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function buildRunner(adapter, outfile) {
  const cli = fileURLToPath(new URL('../core/src/external/cli.ts', import.meta.url));
  await build({
    stdin: { contents: `import create from ${JSON.stringify(resolve(adapter))};\nimport {serveRunner} from ${JSON.stringify(cli)};\nprocess.exitCode = await serveRunner(create);`,
      resolveDir: process.cwd(), sourcefile: 'k-runner-entry.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: resolve(outfile),
    banner: { js: '#!/usr/bin/env node' },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , adapter, outfile] = process.argv;
  if (!adapter || !outfile) throw new Error('Usage: node scripts/build-runner.mjs <trusted-adapter.ts> <runner.mjs>');
  await buildRunner(adapter, outfile);
}
