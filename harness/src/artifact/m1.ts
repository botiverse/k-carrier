/**
 * M1 exit checks — the swap-tool demo runs a REAL upgrade through core's
 * Upgrader (createUpgrader facade): end-to-end promotion with state
 * assertions read via upgrader.state() (never internal files), and
 * automatic rollback of a version that fails to start.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { type ToothContext } from "../teeth/registry.ts";
import type { TxnState } from "../../../core/src/txn/state.ts";
import { currentPlatformKey } from "../../../core/src/artifact/staticManifestSource.ts";
import { FakeServer } from "../fake-server/server.ts";
import { ArtifactFactory } from "../artifact-factory/factory.ts";
import { runCommand } from "../artifact-factory/run.ts";
import { CLI_TOOL_SOURCE } from "../../../examples/swap-tool/source.ts";

/** The swap-tool demo's @k-carrier/core wiring (createUpgrader module URL). */
export function coreUpgraderUrl(): string {
  return pathToFileURL(path.join(import.meta.dirname, "../../../core/src/createUpgrader.ts")).href;
}

/** Root public keys the demo trusts (the serving servers' roots). */
function rootKeysEnv(servers: FakeServer[]): Record<string, string> {
  return { K_ROOT_KEYS: JSON.stringify(servers.map((s) => s.rootKeyPem)) };
}

export function swapToolEnv(ctx: ToothContext, baseUrl: string, servers: FakeServer[]): Record<string, string> {
  return {
    K_RELEASE_BASE: baseUrl,
    K_STATE_DIR: path.join(ctx.sandboxDir, "state"),
    K_CORE_UPGRADER: coreUpgraderUrl(),
    ...rootKeysEnv(servers),
  };
}

/** Build the swap-tool demo binary (v1.0.0, ok) into <sandbox>/app. */
export async function buildSwapTool(ctx: ToothContext): Promise<string> {
  const factory = new ArtifactFactory({
    cacheDir: path.join(ctx.sandboxDir, "cache"),
    demoSource: CLI_TOOL_SOURCE,
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
    const binPath = path.join(appDir, "swap-tool");
    await fs.writeFile(binPath, rel.artifactBytes, { mode: 0o755 });
    await fs.writeFile(
      path.join(appDir, "k.target.ts"),
      `export default { version: ["--version"], selfUpgrade: ["self", "upgrade"] };\n`,
    );
    return binPath;
  } finally {
    await buildServer.stop();
  }
}

/** Read the transaction state through the PUBLIC API (upgrader.state()). */
export async function readState(env: Record<string, string>): Promise<TxnState> {
  const coreSrcUrl = new URL(".", env.K_CORE_UPGRADER).href;
  const script = [
    `const { createUpgrader } = await import(${JSON.stringify(env.K_CORE_UPGRADER)});`,
    `const { staticManifestSource } = await import(${JSON.stringify(new URL("artifact/staticManifestSource.ts", coreSrcUrl).href)});`,
    `const u = createUpgrader({`,
    `  host: { quiesce: async () => {}, stop: async () => {}, start: async () => {}, healthProbe: async () => ({ version: "x", pid: 0, startId: "x" }), resume: async () => {} },`,
    `  source: staticManifestSource({ baseUrl: ${JSON.stringify("http://127.0.0.1:1")} }),`,
    `  policy: "auto", notificationSink: async () => {}, rootKeys: [],`,
    `  stateDir: ${JSON.stringify(env.K_STATE_DIR)},`,
    `});`,
    `process.stdout.write(JSON.stringify(await u.state()));`,
  ].join("\n");
  const r = await runCommand(process.execPath, ["--input-type=module", "-e", script], { timeoutMs: 30000 });
  if (r.code !== 0) throw new Error(`state() read failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout) as TxnState;
}

/** Serve a release on a fresh fake-server (seed or target). */
export async function serveRelease(
  ctx: ToothContext,
  opts: { version: string; behavior: "ok" | "crash-on-start"; name: string; unsigned?: boolean },
): Promise<FakeServer> {
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, `serve-${opts.name}`) });
  await server.start();
  const factory = new ArtifactFactory({
    cacheDir: path.join(ctx.sandboxDir, `cache-${opts.name}`),
    demoSource: CLI_TOOL_SOURCE,
  });
  const release = {
    version: opts.version,
    behavior: opts.behavior,
    store: server.store,
    platform: currentPlatformKey(),
    ...(opts.unsigned === true ? { unsigned: true as const } : {}),
  };
  await factory.makeRelease(release);
  return server;
}

/**
 * M1 exit tooth ①: the swap-tool does a REAL upgrade through core's
 * Upgrader — seed stable 1.0.0, serve 2.0.0, self upgrade, next run
 * reports 2.0.0, and upgrader.state() shows the transaction committed
 * (phase promoted, stable 2.0.0, experiment cleared).
 */
export async function checkSwapToolUpgradeLoop(
  ctx: ToothContext,
  opts: { serveBadVersion?: boolean } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  const seed = await serveRelease(ctx, { version: "1.0.0", behavior: "ok", name: "seed" });
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: opts.serveBadVersion ? "crash-on-start" : "ok",
    name: "target",
  });
  try {
    // seed: a real first upgrade lands stable 1.0.0
    const seedEnv = swapToolEnv(ctx, seed.url, [seed, target]);
    const seedRun = await runCommand(binPath, ["self", "upgrade"], { env: seedEnv, timeoutMs: 30000 });
    assert.equal(seedRun.code, 0, `seed upgrade must exit 0 (${seedRun.stderr.trim()})`);
    const seeded = await readState(seedEnv);
    assert.equal(seeded.stableVersion, "1.0.0", "seed upgrade must land stable 1.0.0");

    // the real upgrade to the served version
    const targetEnv = swapToolEnv(ctx, target.url, [seed, target]);
    const up = await runCommand(binPath, ["self", "upgrade"], { env: targetEnv, timeoutMs: 30000 });
    assert.equal(
      up.code,
      0,
      `self upgrade must exit 0 (${up.stderr.trim()}; serveBadVersion mutation => RED)`,
    );

    const v = await runCommand(binPath, ["--version"], { timeoutMs: 30000 });
    assert.equal(v.code, 0);
    assert.equal(
      v.stdout.trim(),
      "2.0.0",
      "next run must report the served version (serveBadVersion mutation => RED)",
    );

    // transaction committed: read via upgrader.state(), never internal files
    const state = await readState(targetEnv);
    assert.equal(state.stableVersion, "2.0.0", "stable slot must hold the new version");
    assert.equal(state.experimentVersion, null, "experiment slot must be cleared after promote");
    assert.equal(state.phase, "promoted", "journal must end at promoted");
  } finally {
    await seed.stop();
    await target.stop();
  }
}

/**
 * M1 exit tooth ②: a bad version rolls back — serve 2.0.0
 * crash-on-start, self upgrade must end rolled-back, the OLD version stays
 * usable, and the experiment slot is cleared.
 */
export async function checkSwapToolRollback(
  ctx: ToothContext,
  opts: { serveGoodVersion?: boolean } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  const seed = await serveRelease(ctx, { version: "1.0.0", behavior: "ok", name: "seed" });
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: opts.serveGoodVersion ? "ok" : "crash-on-start",
    name: "target",
  });
  try {
    const seedEnv = swapToolEnv(ctx, seed.url, [seed, target]);
    const seedRun = await runCommand(binPath, ["self", "upgrade"], { env: seedEnv, timeoutMs: 30000 });
    assert.equal(seedRun.code, 0, `seed upgrade must exit 0 (${seedRun.stderr.trim()})`);

    const targetEnv = swapToolEnv(ctx, target.url, [seed, target]);
    const up = await runCommand(binPath, ["self", "upgrade"], { env: targetEnv, timeoutMs: 30000 });

    const state = await readState(targetEnv);
    if (opts.serveGoodVersion) {
      // mutation: a GOOD version is served — it promotes, so the rollback
      // expectation must go RED
      assert.equal(state.phase, "rolled-back", "a bad version must roll back (good version => RED)");
      return;
    }
    assert.equal(up.code, 1, `upgrade to a bad version must exit non-zero (${up.stderr.trim()})`);
    assert.equal(state.phase, "rolled-back", "journal must end at rolled-back");
    assert.equal(state.stableVersion, "1.0.0", "stable must still hold the old version");
    assert.equal(state.experimentVersion, null, "experiment slot must be cleared");

    // the old version stays usable
    const v = await runCommand(binPath, ["--version"], { timeoutMs: 30000 });
    assert.equal(v.code, 0);
    assert.equal(v.stdout.trim(), "1.0.0", "the old binary must still run after rollback");
  } finally {
    await seed.stop();
    await target.stop();
  }
}
