import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { type ToothContext } from "../teeth/registry.ts";
import { currentPlatformKey } from "../../../core/src/artifact/staticManifestSource.ts";
import { FakeServer } from "../fake-server/server.ts";
import { ArtifactFactory } from "../artifact-factory/factory.ts";
import { processAlive } from "../fake-host/daemon.ts";
import { runCommand } from "../artifact-factory/run.ts";
import { PLAIN_DAEMON_SOURCE } from "../../../examples/service-daemon/source.ts";
import { coreUpgraderUrl, readState } from "./m1.ts";

/**
 * M3 host orchestration helpers — shared by both service-profile teeth
 * (m3.service-upgrade / m3.service-rollback), each of which runs on BOTH
 * host shapes:
 *  - spawn:   self-starting — the driver spawns the successor and finishes
 *             the transaction itself.
 *  - respawn: computer's shape — the driver DIES mid-handover (it cannot
 *             start itself; the owner respawns it from the new bytes), and
 *             the SUCCESSOR finishes the transaction via recovery, proving
 *             the handover by a fresh startId (a flag could be set by the
 *             crash path; a different incarnation is something that
 *             happened).
 */

export type HostShape = "spawn" | "respawn";
export const HOST_SHAPES: HostShape[] = ["spawn", "respawn"];

const INCARNATION_FILE = "incarnation.json";

/** Build the service-daemon demo binary (v1.0.0, ok) into <sandbox>/app. */
export async function buildServiceDaemon(ctx: ToothContext): Promise<string> {
  const factory = new ArtifactFactory({
    cacheDir: path.join(ctx.sandboxDir, "cache"),
    demoSource: PLAIN_DAEMON_SOURCE,
  });
  const buildServer = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "build") });
  await buildServer.start();
  try {
    const rel = await factory.makeRelease({
      version: "1.0.0",
      behavior: "ok",
      store: buildServer.store,
      platform: currentPlatformKey(),
    });
    const appDir = path.join(ctx.sandboxDir, "app");
    await fs.mkdir(appDir, { recursive: true });
    const binPath = path.join(appDir, "service-daemon");
    await fs.writeFile(binPath, rel.artifactBytes, { mode: 0o755 });
    return binPath;
  } finally {
    await buildServer.stop();
  }
}

function stateDir(ctx: ToothContext): string {
  return path.join(ctx.sandboxDir, "state");
}

export function serviceEnv(
  ctx: ToothContext,
  shape: HostShape,
  baseUrl: string,
  servers: FakeServer[],
): Record<string, string> {
  return {
    K_RELEASE_BASE: baseUrl,
    K_STATE_DIR: stateDir(ctx),
    K_HOST_SHAPE: shape,
    K_CORE_UPGRADER: coreUpgraderUrl(),
    K_ROOT_KEYS: JSON.stringify(servers.map((s) => s.rootKeyPem)),
    // Every process this tooth spawns — and, via inheritance, every process
    // the driver spawns — carries the sandbox marker, so the sandbox
    // teardown's verifyProcessTreeDead is the backstop for any leak: a "red"
    // can never degrade into a hang.
    K_SANDBOX_MARKER: path.basename(ctx.sandboxDir),
  };
}

export interface Incarnation {
  version: string;
  pid: number;
  startId: string;
}

export async function readIncarnation(ctx: ToothContext): Promise<Incarnation | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(stateDir(ctx), INCARNATION_FILE), "utf8"),
    ) as Incarnation;
  } catch {
    return null;
  }
}

export function spawnService(binPath: string, env: Record<string, string>): { child: ChildProcess; pid: number } {
  const child = spawn(binPath, [], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (!child.pid) throw new Error("service did not get a pid");
  return { child, pid: child.pid };
}

function readLine(child: ChildProcess, prefix: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for "${prefix}" from service`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      // Only COMPLETE lines (newline-terminated) are protocol messages.
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
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

/** Ready line, or null fast when the child exits / times out. */
export function tryReady(child: ChildProcess, timeoutMs: number): Promise<Incarnation | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Incarnation | null): void => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    readLine(child, "ready", timeoutMs)
      .then((line) => finish(JSON.parse(line) as Incarnation))
      .catch(() => finish(null));
    child.once("exit", () => finish(null));
  });
}

export async function waitDead(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  }
}

/** Kill the running incarnation and prove it is gone (cleanup discipline). */
export async function killIncarnation(ctx: ToothContext): Promise<void> {
  const inc = await readIncarnation(ctx);
  if (inc && processAlive(inc.pid)) {
    try {
      process.kill(inc.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await waitDead(inc.pid, 5000);
  }
}

/**
 * The OWNER (respawn shape): the driver exits mid-handover; the owner
 * respawns the service from the new bytes (experiment first), falling back
 * to stable when the new version cannot start, and respawning again when a
 * recovery asks for a successor by exiting. A bounded loop: the service
 * eventually stays up or the owner gives up.
 */
export async function respawnUntilUp(
  ctx: ToothContext,
  env: Record<string, string>,
): Promise<{ info: Incarnation; child: ChildProcess }> {
  const dir = stateDir(ctx);
  for (let attempt = 0; attempt < 6; attempt++) {
    const slot: "experiment" | "stable" = attempt === 0 ? "experiment" : "stable";
    const artifact = path.join(dir, "slots", slot, "artifact.bin");
    try {
      await fs.access(artifact);
    } catch {
      continue;
    }
    const child = spawn(process.execPath, [artifact], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const info = await tryReady(child, 2000);
    if (info !== null) return { info, child };
    if (child.pid && processAlive(child.pid)) child.kill("SIGKILL");
  }
  throw new Error("owner: the service never came up");
}

/**
 * Seed the service world: spawn the v1 service (registers), then a real
 * driver upgrade to 1.0.0 lands stable v1 with a running incarnation
 * (driver-completed on spawn, successor-completed on respawn).
 */
export async function seedService(
  ctx: ToothContext,
  shape: HostShape,
  binPath: string,
  seedServer: FakeServer,
): Promise<{ seedChild: ChildProcess; seedPid: number }> {
  const env = serviceEnv(ctx, shape, seedServer.url, [seedServer]);
  const { child, pid } = spawnService(binPath, env);
  const ready = JSON.parse(await readLine(child, "ready")) as Incarnation;
  assert.equal(ready.version, "1.0.0", "seed service must run v1");
  assert.ok(processAlive(ready.pid), "seed service must be alive");

  const up = await runCommand(binPath, ["self", "upgrade"], { env, timeoutMs: 30000 });
  assert.equal(up.code, 0, `seed upgrade must exit 0 (${up.stderr.trim()})`);
  if (shape === "respawn") {
    await respawnUntilUp(ctx, env); // the driver died; the owner brings the successor up
  }
  const seeded = await readState(env);
  assert.equal(seeded.stableVersion, "1.0.0", "seed upgrade must land stable 1.0.0");
  const running = await readIncarnation(ctx);
  assert.ok(running, "a service must be running after the seed upgrade");
  assert.equal(running.version, "1.0.0");
  assert.ok(processAlive(running.pid), "the seeded service must be alive");
  return { seedChild: child, seedPid: pid };
}
