# Runnable service upgrade walkthrough

This example has a service with no K dependency, a command controller, and a
runner built with a trusted adapter. It uses local temporary files and a `data:`
release URL, so it needs no cloud account or published application release.
Run the commands from the repository root with Node 24 and pnpm installed.

## Prepare an installation

The temporary home contains the example controller, application data and a K state
subdirectory. The helper and interpreter are outside the K slots. The setup step
creates trusted v1 bytes, seeds stable, starts the service and prepares a v2 release.

```sh
pnpm install --frozen-lockfile
export K_EXAMPLE_HOME="$(mktemp -d)"
node scripts/build-runner.mjs examples/external-service/adapter.ts "$K_EXAMPLE_HOME/runner.mjs"
node --input-type=module <<'JS'
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bootstrapStable, createCommandHost } from './core/src/index.ts';
const dir = process.env.K_EXAMPLE_HOME;
const stateDir = join(dir, 'k');
await copyFile('examples/external-service/controller.mjs', join(dir, 'controller.mjs'));
const template = await readFile('examples/external-service/service.mjs', 'utf8');
const initial = join(dir, 'initial.mjs');
await writeFile(initial, template.replace('VERSION_PLACEHOLDER', '1.0.0'));
await bootstrapStable({ stateDir, version: '1.0.0', artifactPath: initial });
const candidate = Buffer.from(template.replace('VERSION_PLACEHOLDER', '2.0.0'));
await writeFile(join(dir, 'release.json'), JSON.stringify({ version: '2.0.0',
  url: `data:application/octet-stream;base64,${candidate.toString('base64')}`,
  sha256: createHash('sha256').update(candidate).digest('hex'), size: candidate.length }));
const host = createCommandHost({ stateDir, command: [process.execPath, join(dir, 'controller.mjs'), dir] });
await host.start('stable');
console.log(await host.healthProbe()); // version 1.0.0 plus pid/startId
JS
```

`bootstrapStable` only initializes the fallback. It does not represent an upgrade
operation, so a status request at this point can report `genesis` even though v1
is installed and running.

## Upgrade, retry and observe

```sh
printf '%s' '{"protocolVersion":1,"action":"upgrade","id":"demo-v2","targetVersion":"2.0.0","consented":true}' | node "$K_EXAMPLE_HOME/runner.mjs"
printf '%s' '{"protocolVersion":1,"action":"upgrade","id":"demo-v2","targetVersion":"2.0.0","consented":true}' | node "$K_EXAMPLE_HOME/runner.mjs"
printf '%s' '{"protocolVersion":1,"action":"status"}' | node "$K_EXAMPLE_HOME/runner.mjs"
```

The first response should say `result: "promoted"`, `exitCode: 0` and carry an
operation with `outcome: "promoted"`. The second says `result: "replayed"` and
returns the same operation without restarting the application. Status reads the
current receipt. Probe separately for a live observation:

```sh
printf '%s' '{"protocolVersion":1,"action":"probe"}' | node "$K_EXAMPLE_HOME/controller.mjs" "$K_EXAMPLE_HOME"
```

The probe should report version 2.0.0 with a different pid/startId from setup.
These are **different protocols**: upgrade/recover/status go to the runner;
probe/start/stop/quiesce/resume go to the application controller.

## Recovery and cleanup

For interrupted work, start a runner against the same state directory and submit
`{"protocolVersion":1,"action":"recover"}`. Recovery completes persisted intent
or restores stable; it does not initiate another upgrade. See the
[protocol's exit-code table](../../docs/design.md#protocol-v1), including
why a successful rollback is exit 1.

Stop this demo before removing its temporary home:

```sh
node --input-type=module <<'JS'
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCommandHost } from './core/src/index.ts';
const dir = process.env.K_EXAMPLE_HOME;
if (!dir) throw new Error('K_EXAMPLE_HOME is required');
const host = createCommandHost({ stateDir: join(dir, 'k'),
  command: [process.execPath, join(dir, 'controller.mjs'), dir] });
await host.stop('stable');
await rm(dir, { recursive: true });
JS
unset K_EXAMPLE_HOME
```

## What this proves

`pnpm test:runner` automates upgrade, wrong-version rollback, current/archive
replay, concurrent lock rejection, killing the runner between stop and start,
and recovery with the release source removed. The test owns and cleans its own
home; it does not reuse the walkthrough's directory.

This controller is a demo, not a production supervisor. Its service implements
cooperative shutdown and a loopback health protocol; an unreachable endpoint is
not generally proof that an arbitrary production process has died. A product
controller must establish process ownership and termination through its service
manager, authenticate control access, and implement workload preservation.
The demo copies selected slot bytes to `active.mjs` so Node treats them as ESM;
that runtime copy is not a third rollback slot. Localhost is not authentication.
