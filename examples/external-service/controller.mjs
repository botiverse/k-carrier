// External ops controller. Start/stop do not invoke an upgrade command in the service.
import { spawn } from 'node:child_process';
import { readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const dir = process.argv[2];
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.protocolVersion !== 1) throw new Error('unsupported protocol');
async function probe(route = '/health') {
  const endpoint = JSON.parse(await readFile(join(dir, 'endpoint.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
    method: route === '/health' ? 'GET' : 'POST', signal: AbortSignal.timeout(1000),
  });
  const evidence = await response.json();
  if (evidence.pid !== endpoint.pid || evidence.startId !== endpoint.startId) throw new Error('incarnation mismatch');
  return evidence;
}
async function alive() { try { return await probe(); } catch { return null; } }
async function waitFor(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(20); }
  throw new Error('lifecycle deadline');
}
let evidence;
switch (request.action) {
  case 'quiesce': case 'resume':
    if (await alive()) await probe(`/${request.action}`);
    break;
  case 'stop':
    if (await alive()) await probe('/stop');
    await waitFor(async () => !(await alive()));
    break;
  case 'start': {
    const expected = (await readFile(join(request.artifactPath, '..', 'VERSION'), 'utf8')).trim();
    const current = await alive();
    if (current) {
      if (current.version !== expected) throw new Error('another incarnation still runs');
      break;
    }
    const executable = join(dir, 'active.mjs');
    await copyFile(request.artifactPath, executable);
    const child = spawn(process.execPath, [executable, dir], { detached: true, stdio: 'ignore' });
    child.unref();
    await waitFor(async () => Boolean(await alive()));
    break;
  }
  case 'probe': evidence = await probe(); break;
  default: throw new Error('unknown action');
}
process.stdout.write(JSON.stringify({ protocolVersion: 1, ok: true, ...(evidence ? { evidence } : {}) }));
