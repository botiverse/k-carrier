/**
 * L0 artifact acceptance checks — run bodies of the M1 artifact teeth
 * (registered in teeth/artifact.ts). Each throws on violation.
 *
 * The checks consume core's public L0 API (dogfood: the harness is the
 * first consumer) against the fake-server + artifact-factory + real
 * processes:
 *  - a tampered artifact is REFUSED (sha256) — real tamper -> real reject;
 *  - a kill mid-swap leaves the OLD bytes intact (real process, real
 *    SIGKILL — the atomicity contract lives in process reality);
 *  - unknown channel values fail closed.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { type ToothContext } from "../teeth/registry.ts";
import { parseSelector, resolveSelector, type ReleaseSelector } from "../../../core/src/artifact/selector.ts";
import { parseManifest, currentPlatformKey, type Manifest } from "../../../core/src/artifact/manifest.ts";
import { downloadVerified } from "../../../core/src/artifact/download.ts";
import { atomicWriteFile } from "../../../core/src/artifact/swap.ts";
import { FakeServer } from "../fake-server/server.ts";
import { ArtifactFactory } from "../artifact-factory/factory.ts";
import { MANIFEST_FILE } from "../fake-server/manifest.ts";
import { processAlive } from "../fake-host/daemon.ts";

// ---------------------------------------------------------------------------
// tampered artifact => refuse install
// ---------------------------------------------------------------------------

export async function checkTamperedArtifactRefused(
  ctx: ToothContext,
  opts: { skipTamper?: boolean } = {},
): Promise<void> {
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store") });
  await server.start();
  const factory = new ArtifactFactory({ cacheDir: path.join(ctx.sandboxDir, "cache") });
  try {
    const platform = currentPlatformKey();
    const rel = await factory.makeRelease({
      version: "1.0.0",
      behavior: "ok",
      store: server.store,
      platform,
    });
    const manifest = parseManifest(
      new TextDecoder().decode(await server.store.readFile(MANIFEST_FILE)),
    );
    const target = manifest.targets[platform];
    assert.ok(target, "release manifest must carry the current platform target");
    if (!opts.skipTamper) {
      await server.corruptByte(rel.artifactFile, 0);
    }
    // core's L0 consumer must refuse the (tampered) artifact
    await assert.rejects(
      downloadVerified(server.url, target, { timeoutMs: 5000 }),
      /SHA256_MISMATCH/,
      "a tampered artifact must be refused (skipTamper mutation => RED)",
    );
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// kill mid-swap => old bytes intact
// ---------------------------------------------------------------------------

const MID_SWAP_PAYLOAD_BYTES = 64 * 1024 * 1024; // 64MiB: long enough to catch mid-write

export async function checkKillMidSwapPreservesOld(
  ctx: ToothContext,
  opts: { skipKill?: boolean } = {},
): Promise<void> {
  const targetPath = path.join(ctx.sandboxDir, "app.bin");
  const oldBytes = new TextEncoder().encode("old-version-bytes");
  await atomicWriteFile(targetPath, oldBytes);

  const swapModuleUrl = pathToFileURL(
    path.join(import.meta.dirname, "../../../core/src/artifact/swap.ts"),
  ).href;
  const script = [
    `import { atomicWriteFile } from ${JSON.stringify(swapModuleUrl)};`,
    `const fs = await import("node:fs");`,
    `const data = new Uint8Array(${MID_SWAP_PAYLOAD_BYTES});`,
    `data.fill(0x42);`,
    `await atomicWriteFile(process.env.K_SWAP_TARGET, data);`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, K_SWAP_TARGET: targetPath },
    stdio: "ignore", // no pipes: a failed assertion must not degrade into a hang
  });

  try {
    if (opts.skipKill) {
      // mutation: the kill never lands — the swap completes, so the
      // "old bytes intact" assertion must go RED
      await waitForExit(child);
      assert.ok(
        await equalsFile(targetPath, oldBytes),
        "kill mid-swap must leave the old bytes intact (no kill => RED)",
      );
      return;
    }

    // Wait for the temp file (created BEFORE any data is written), then
    // freeze the child mid-swap: the rename cannot have happened yet.
    await waitForFile(`${targetPath}.tmp`);
    child.kill("SIGSTOP");
    assert.ok(
      await equalsFile(targetPath, oldBytes),
      "the kill must land mid-swap (before the rename)",
    );

    // Real SIGKILL: the old bytes must be intact and complete.
    child.kill("SIGKILL");
    assert.ok(
      await equalsFile(targetPath, oldBytes),
      "kill mid-swap must leave the old bytes intact",
    );

    // Recovery: a subsequent swap succeeds (the leftover .tmp is truncated).
    const recovered = new TextEncoder().encode("recovered");
    await atomicWriteFile(targetPath, recovered);
    assert.deepEqual(new Uint8Array(await fs.readFile(targetPath)), recovered);
  } finally {
    if (child.pid && processAlive(child.pid)) child.kill("SIGKILL");
    await fs.rm(`${targetPath}.tmp`, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// unknown channel => fail-closed
// ---------------------------------------------------------------------------

/** channelName is the PUBLISHER's own vocabulary — any string is legitimate. */
function buildTestManifest(version: string, platform: string, channelName?: string): Manifest {
  const o: Record<string, unknown> = {
    version,
    targets: { [platform]: { file: "app.bin", sha256: "a".repeat(64), size: 1 } },
  };
  if (channelName !== undefined) o.channels = { [channelName]: version };
  return parseManifest(JSON.stringify(o));
}

/** Mutation stand-in: a parser that accepts any string as a channel. */
const lenientParse = (s: string): ReleaseSelector => ({ kind: "channel", name: s });

export async function checkChannelFailClosed(
  _ctx: ToothContext,
  opts: { lenient?: boolean } = {},
): Promise<void> {
  const platform = currentPlatformKey();
  const manifest = buildTestManifest("1.0.0", platform, "stable");
  if (opts.lenient) {
    // mutation: a parser that accepts anything — the fail-closed
    // assertions must go RED against it
    assert.throws(() => lenientParse("nonsense"), /CHANNEL_INVALID/);
    return;
  }
  // An adopter-owned name is accepted as a NAME (K invents no vocabulary),
  // but must be published by the manifest or it fails closed.
  assert.throws(() => parseSelector("   "), /CHANNEL_INVALID/);
  assert.throws(() => parseSelector("pinned:"), /CHANNEL_INVALID/);
  assert.throws(
    () => resolveSelector(manifest, parseSelector("nightly"), platform),
    /CHANNEL_NOT_IN_MANIFEST/,
  );
  assert.throws(
    () => resolveSelector(manifest, parseSelector("pinned:2.0.0"), platform),
    /PINNED_VERSION_MISMATCH/,
  );
  assert.throws(() => resolveSelector(manifest, parseSelector("stable"), "windows-arm64"), /UNSUPPORTED_PLATFORM/);
  const resolved = resolveSelector(manifest, parseSelector("stable"), platform);
  assert.equal(resolved.version, "1.0.0");
  // a publisher-declared stream resolves under ITS OWN name — any name.
  const streamManifest = buildTestManifest("2.0.0-rc.1", platform, "canary");
  assert.equal(
    resolveSelector(streamManifest, parseSelector("canary"), platform).version,
    "2.0.0-rc.1",
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function waitForFile(p: string): Promise<void> {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await fs.access(p);
      return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`file ${p} never appeared`);
    await new Promise((r) => {
      setTimeout(r, 2);
    });
  }
}

async function equalsFile(p: string, expected: Uint8Array): Promise<boolean> {
  try {
    const got = new Uint8Array(await fs.readFile(p));
    if (got.length !== expected.length) return false;
    for (let i = 0; i < got.length; i++) {
      if (got[i] !== expected[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}
