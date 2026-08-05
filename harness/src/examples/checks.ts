/**
 * Examples acceptance checks — the run bodies of the demo teeth
 * (registered in teeth/examples.ts). Each throws on violation.
 *
 * Each demo is the credential for its profile's support claim
 * (examples/README.md: "if a profile has no green example, the claim does
 * not exist"):
 *  - swap-tool: black-box upgrade loop (L0/L0.5/L1') — version command,
 *    self-upgrade swaps bytes, next run reports the served version;
 *  - service-daemon: process-reality L2/L3 — real spawn, startId-bound
 *    probe evidence, OS-confirmed stop, upgrade effective next spawn;
 *  - hosted-service: adapter contract subset (§1.7) — session preservation
 *    incl. after rollback + probe veracity/binding.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { type ToothContext } from "../teeth/registry.ts";
import { ArtifactFactory, type Behavior } from "../artifact-factory/factory.ts";
import { runCommand } from "../artifact-factory/run.ts";
import { FakeServer } from "../fake-server/server.ts";
import { sha256Hex } from "../fake-server/manifest.ts";
import { processAlive } from "../fake-host/daemon.ts";
import {
  checkLedgerEquivalence,
  checkLedgerEquivalenceAfterRollback,
  checkProbeVersionMatchesSlot,
  checkProbeBindsCurrentIncarnation,
} from "../fake-host/checks.ts";
import type { HostDriver } from "../fake-host/inproc.ts";
import { CLI_TOOL_SOURCE } from "../../../examples/swap-tool/source.ts";
import { PLAIN_DAEMON_SOURCE } from "../../../examples/service-daemon/source.ts";

const RELEASE_BASE_ENV = "K_RELEASE_BASE";

/** The swap-tool's explicit target declaration (mirrors k.target.ts). */
export const CLI_TOOL_TARGET_TS = `export default { version: ["--version"], selfUpgrade: ["self", "upgrade"] };
`;

async function buildDemoBinary(
  ctx: ToothContext,
  opts: { source: string; version: string; behavior: Behavior; name: string },
): Promise<{ binPath: string }> {
  const factory = new ArtifactFactory({
    cacheDir: path.join(ctx.sandboxDir, "cache"),
    demoSource: opts.source,
  });
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store") });
  await server.start();
  try {
    const rel = await factory.makeRelease({
      version: opts.version,
      behavior: opts.behavior,
      store: server.store,
    });
    const binDir = path.join(ctx.sandboxDir, "app");
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, opts.name);
    await fs.writeFile(binPath, rel.artifactBytes, { mode: 0o755 });
    return { binPath };
  } finally {
    await server.stop();
  }
}

async function fileSha256(p: string): Promise<string> {
  return sha256Hex(new Uint8Array(await fs.readFile(p)));
}

// ---------------------------------------------------------------------------
// swap-tool
// ---------------------------------------------------------------------------

export async function checkCliToolBlackbox(
  ctx: ToothContext,
  opts: { serveSameVersion?: boolean } = {},
): Promise<void> {
  const { binPath } = await buildDemoBinary(ctx, {
    source: CLI_TOOL_SOURCE,
    version: "1.0.0",
    behavior: "ok",
    name: "swap-tool",
  });
  await fs.writeFile(path.join(ctx.sandboxDir, "app", "k.target.ts"), CLI_TOOL_TARGET_TS);

  // serve the target release
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store2") });
  await server.start();
  const factory = new ArtifactFactory({
    cacheDir: path.join(ctx.sandboxDir, "cache2"),
    demoSource: CLI_TOOL_SOURCE,
  });
  try {
    const targetVersion = opts.serveSameVersion ? "1.0.0" : "2.0.0";
    await factory.makeRelease({ version: targetVersion, behavior: "ok", store: server.store });

    const before = await fileSha256(binPath);
    const v1 = await runCommand(binPath, ["--version"]);
    assert.equal(v1.code, 0, `version command must exit 0 (${v1.stderr.trim()})`);
    assert.equal(v1.stdout.trim(), "1.0.0");

    const up = await runCommand(binPath, ["self", "upgrade"], {
      env: { [RELEASE_BASE_ENV]: server.url },
    });
    assert.equal(up.code, 0, `self upgrade must exit 0 (${up.stderr.trim()})`);
    const after = await fileSha256(binPath);
    assert.notEqual(after, before, "self upgrade must change the binary bytes on disk");

    const v2 = await runCommand(binPath, ["--version"]);
    assert.equal(v2.code, 0);
    assert.equal(v2.stdout.trim(), targetVersion, "next run must report the served version");

    // the app's real command still works on the new version
    const greet = await runCommand(binPath, ["greet", "K"]);
    assert.equal(greet.code, 0);
    assert.match(greet.stdout, new RegExp(`Hello, K! \\(v${targetVersion}\\)`));
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// service-daemon
// ---------------------------------------------------------------------------

function readLine(child: ChildProcess, prefix: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for "${prefix}" from service-daemon`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        if (line.startsWith(`${prefix} `)) {
          cleanup();
          resolve(line.slice(prefix.length + 1));
          return;
        }
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
    };
    child.stdout?.on("data", onData);
  });
}

async function waitDead(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  }
}

function spawnDaemon(binPath: string): { child: ChildProcess; pid: number } {
  const child = spawn(binPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  if (!child.pid) throw new Error("daemon did not get a pid");
  return { child, pid: child.pid };
}

export async function checkPlainDaemonContract(
  ctx: ToothContext,
  opts: { behavior?: Behavior } = {},
): Promise<void> {
  const { binPath } = await buildDemoBinary(ctx, {
    source: PLAIN_DAEMON_SOURCE,
    version: "1.0.0",
    behavior: opts.behavior ?? "ok",
    name: "service-daemon",
  });

  // 1) process-reality lifecycle: spawn -> probe -> stop, OS-confirmed dead
  const { child, pid } = spawnDaemon(binPath);
  try {
    const ready = JSON.parse(await readLine(child, "ready")) as {
      version: string;
      pid: number;
      startId: string;
    };
    assert.equal(ready.version, "1.0.0");
    assert.equal(ready.pid, pid);
    assert.ok(processAlive(pid), "OS must report the daemon alive after start");

    child.stdin?.write("probe\n");
    const evidence = JSON.parse(await readLine(child, "evidence")) as {
      version: string;
      pid: number;
      startId: string;
    };
    assert.equal(evidence.version, "1.0.0", "probe must report the running version");
    assert.equal(evidence.pid, pid, "evidence must bind the live pid");
    assert.equal(evidence.startId, ready.startId, "evidence must bind the current incarnation");

    child.stdin?.write("exit\n");
    await waitDead(pid);
    assert.ok(!processAlive(pid), "stop must leave the daemon OS-dead");
  } finally {
    if (processAlive(pid)) child.kill("SIGKILL");
  }

  // 2) upgrade: swap bytes, next spawned incarnation reports the new version
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store2") });
  await server.start();
  const factory = new ArtifactFactory({
    cacheDir: path.join(ctx.sandboxDir, "cache2"),
    demoSource: PLAIN_DAEMON_SOURCE,
  });
  try {
    await factory.makeRelease({ version: "2.0.0", behavior: "ok", store: server.store });
    const before = await fileSha256(binPath);
    const up = await runCommand(binPath, ["self", "upgrade"], {
      env: { [RELEASE_BASE_ENV]: server.url },
    });
    assert.equal(up.code, 0, `self upgrade must exit 0 (${up.stderr.trim()})`);
    assert.notEqual(await fileSha256(binPath), before, "upgrade must change the binary bytes");

    const second = spawnDaemon(binPath);
    try {
      const ready2 = JSON.parse(await readLine(second.child, "ready")) as { version: string };
      assert.equal(ready2.version, "2.0.0", "next incarnation must run the new version");
      second.child.stdin?.write("exit\n");
      await waitDead(second.pid);
    } finally {
      if (processAlive(second.pid)) second.child.kill("SIGKILL");
    }
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// hosted-service
// ---------------------------------------------------------------------------

export async function checkManagedHostAdapter(
  ctx: ToothContext,
  opts: { hostOverride?: () => HostDriver } = {},
): Promise<void> {
  // Each contract check needs a FRESH host (checks leave it running);
  // hostOverride is a factory so known-red can inject a broken host.
  const makeHost = async (): Promise<HostDriver> =>
    opts.hostOverride
      ? opts.hostOverride()
      : (await import("../../../examples/hosted-service/host.ts")).createManagedHost(
          path.join(ctx.sandboxDir, "host"),
        );
  // the same contract subset k-harness --adapter runs (§1.7)
  await checkLedgerEquivalence(ctx, { host: await makeHost() });
  await checkLedgerEquivalenceAfterRollback(ctx, { host: await makeHost() });
  await checkProbeVersionMatchesSlot(ctx, { host: await makeHost() });
  await checkProbeBindsCurrentIncarnation(ctx, { host: await makeHost() });
}
