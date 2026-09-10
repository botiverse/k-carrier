#!/usr/bin/env node
// Runnable installer supervisor. Its helper manifest is trusted local demo input.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRunner, resumeRunner } from '../../core/src/index.ts';
const dir = process.env.K_EXAMPLE_HOME;
if (!dir) throw new Error('K_EXAMPLE_HOME is required');
const [action, id, targetVersion] = process.argv.slice(2);
if (action === 'recover' && id && !targetVersion) {
  const result = await resumeRunner(id);
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
} else if (action === 'upgrade' && id && targetVersion) {
  const release = JSON.parse(await readFile(join(dir, 'runner-release.json'), 'utf8'));
  process.exitCode = await launchRunner({ release, scratchDir: join(dir, 'installer'),
    interpreter: process.execPath, request: { protocolVersion: 1, action: 'upgrade', id, targetVersion, consented: true } });
} else {
  throw new Error('Usage: install.mjs upgrade <operation-id> <target-version> | recover <recovery.json>');
}
