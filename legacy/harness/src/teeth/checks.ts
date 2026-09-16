/**
 * M0 acceptance checks — the run bodies of the fake-server + sandbox teeth
 * (registered in m0.ts).
 *
 * Each check throws on violation (a tooth goes red by throwing). The checks
 * are exported separately so the self-verification tests can drive
 * known-red by running a check against a mutated world (a no-op tamper, a
 * shared dir) — the tooth must throw then, exactly like the mutation-runner
 * will demand.
 *
 * The oracle is sha256: K verifies integrity, not authenticity (design-v1
 * §L0.5), so every tamper op here is judged by "do the served bytes still
 * hash to what the manifest promises". Signature-chain checks lived here
 * until 2026-08-06 and were removed with the feature -- a tooth for a
 * guarantee the product does not make is worse than no tooth.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type ToothContext } from "./registry.ts";
import { FakeServer, type PublishedRelease } from "../fake-server/server.ts";
import {
  MANIFEST_FILE,
  compareVersions,
  sha256Hex,
  type Manifest,
} from "../fake-server/manifest.ts";
import { createSandbox } from "../scenario/sandbox.ts";

export const M0_ARTIFACT = "app-1.0.0.bin";
export const M0_ARTIFACT_B = "app-1.0.0-extra.bin";
const PAYLOAD = "K fake-server payload";
const PAYLOAD_V2 = "K fake-server payload v2";

export interface ReleaseFixture {
  server: FakeServer;
  artifact: string;
  artifactBytes: Uint8Array;
  manifest: Manifest;
}

/** Start a fake-server with one published release inside the tooth sandbox. */
export async function setupRelease(
  ctx: ToothContext,
  opts: {
    artifacts?: Record<string, string>;
    version?: string;
    platform?: string;
    binary?: string;
  } = {},
): Promise<ReleaseFixture> {
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store") });
  await server.start();
  const artifacts = opts.artifacts ?? { [M0_ARTIFACT]: PAYLOAD };
  const names = Object.keys(artifacts);
  const artifact = opts.binary ?? (names.length === 1 ? names[0] : undefined);
  if (!artifact) throw new Error("setupRelease: no artifact selected");
  const content = artifacts[artifact];
  if (content === undefined) throw new Error(`setupRelease: artifact ${artifact} has no content`);
  const released: PublishedRelease = await server.publishRelease({
    version: opts.version ?? "1.0.0",
    artifacts,
    platform: opts.platform ?? "darwin-arm64",
    binary: artifact,
  });
  return {
    server,
    artifact,
    artifactBytes: new TextEncoder().encode(content),
    manifest: released.manifest,
  };
}

export async function fetchBytes(
  server: FakeServer,
  file: string,
): Promise<{ status: number; body: Uint8Array }> {
  const res = await fetch(`${server.url}/${file}`);
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * Does the file the server currently serves still hash to `expected`?
 *
 * Fetch failures return false rather than throwing: for these checks a file
 * that cannot be fetched is as much a mismatch as wrong bytes, and both are
 * reported by the caller's own assertion message.
 */
export async function servedHashMatches(
  server: FakeServer,
  file: string,
  expected: string,
): Promise<boolean> {
  const res = await fetchBytes(server, file);
  if (res.status !== 200) return false;
  return sha256Hex(res.body) === expected;
}

// ---------------------------------------------------------------------------
// Checks (exported for known-red driving). Each throws on violation.
// ---------------------------------------------------------------------------

export async function checkServesConsistentRelease(
  ctx: ToothContext,
  mutate?: (server: FakeServer, fx: ReleaseFixture) => Promise<void>,
): Promise<void> {
  const fx = await setupRelease(ctx);
  try {
    if (mutate) await mutate(fx.server, fx);
    const m = await fetchBytes(fx.server, MANIFEST_FILE);
    assert.equal(m.status, 200, "manifest must be served");
    const manifest = JSON.parse(new TextDecoder().decode(m.body)) as Manifest;
    assert.equal(manifest.version, "1.0.0");
    const target = manifest.targets["darwin-arm64"];
    assert.ok(target, "manifest must carry the published platform target");
    assert.equal(target.file, fx.artifact);
    assert.equal(target.sha256, sha256Hex(fx.artifactBytes));
    assert.equal(target.size, fx.artifactBytes.length);

    const art = await fetchBytes(fx.server, fx.artifact);
    assert.equal(art.status, 200, "artifact must be served");
    // sha256, not deepEqual: a byte-equality assertion here would fire FIRST
    // and report "bytes differ" for a corruption whose tested property is
    // manifest/bytes disagreement -- an unrelated earlier reason masking the
    // one under test.
    assert.equal(sha256Hex(art.body), target.sha256, "served bytes must match manifest sha256");

  } finally {
    await fx.server.stop();
  }
}

export async function checkCorruptByteRejects(
  ctx: ToothContext,
  mutate?: (server: FakeServer) => Promise<void>,
): Promise<void> {
  const fx = await setupRelease(ctx);
  try {
    if (mutate) await mutate(fx.server);
    else await fx.server.corruptByte(fx.artifact, 0);
    const published = sha256Hex(fx.artifactBytes);
    assert.equal(
      await servedHashMatches(fx.server, fx.artifact, published),
      false,
      "corrupted artifact must no longer hash to the published digest",
    );
    // isolation: untouched files must still be intact
    const m = await fetchBytes(fx.server, MANIFEST_FILE);
    assert.equal(m.status, 200, "untampered manifest must still be served");
    const manifest = JSON.parse(new TextDecoder().decode(m.body)) as Manifest;
    assert.equal(
      manifest.targets["darwin-arm64"]?.sha256,
      published,
      "tampering the artifact must not have rewritten the manifest",
    );
  } finally {
    await fx.server.stop();
  }
}

export async function checkSwapArtifactsRejects(
  ctx: ToothContext,
  mutate?: (server: FakeServer) => Promise<void>,
): Promise<void> {
  const bytesB = "K fake-server payload B";
  const fx = await setupRelease(ctx, {
    artifacts: { [M0_ARTIFACT]: PAYLOAD, [M0_ARTIFACT_B]: bytesB },
    binary: M0_ARTIFACT,
  });
  const expected = new Map([
    [M0_ARTIFACT, sha256Hex(fx.artifactBytes)],
    [M0_ARTIFACT_B, sha256Hex(new TextEncoder().encode(bytesB))],
  ]);
  try {
    if (mutate) await mutate(fx.server);
    else await fx.server.swapFiles(M0_ARTIFACT, M0_ARTIFACT_B);
    // Both names must be wrong, not just one: a swap that moved a single file
    // would leave the other intact, and a check that only looked at the binary
    // would call that a detected swap.
    for (const [name, digest] of expected) {
      assert.equal(
        await servedHashMatches(fx.server, name, digest),
        false,
        `swapped artifact ${name} must no longer hash to its published digest`,
      );
    }
  } finally {
    await fx.server.stop();
  }
}

export async function checkServeOlderVersion(
  ctx: ToothContext,
  mutate?: (server: FakeServer) => Promise<string>,
): Promise<void> {
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store") });
  await server.start();
  try {
    await server.publishRelease({
      version: "1.0.0",
      artifacts: { "app-1.0.0.bin": PAYLOAD },
      platform: "darwin-arm64",
    });
    await server.publishRelease({
      version: "2.0.0",
      artifacts: { "app-2.0.0.bin": PAYLOAD_V2 },
      platform: "darwin-arm64",
    });
    const older = mutate ? await mutate(server) : await server.serveOlderVersion();
    assert.equal(older, "1.0.0", "serveOlderVersion must switch to the older release");
    const m = await fetchBytes(server, MANIFEST_FILE);
    const manifest = JSON.parse(new TextDecoder().decode(m.body)) as Manifest;
    assert.equal(
      compareVersions(manifest.version, "2.0.0"),
      -1,
      "served manifest version must be strictly older than the previously active one",
    );
    const oldArt = await fetchBytes(server, "app-1.0.0.bin");
    assert.equal(oldArt.status, 200, "older release's artifacts must be served");
  } finally {
    await server.stop();
  }
}

export async function checkDropFileRemoves(
  ctx: ToothContext,
  mutate?: (server: FakeServer) => Promise<void>,
): Promise<void> {
  const fx = await setupRelease(ctx);
  try {
    if (mutate) await mutate(fx.server);
    else await fx.server.dropFile(fx.artifact);
    const art = await fetchBytes(fx.server, fx.artifact);
    assert.equal(art.status, 404, "dropped file must no longer be served");
    const m = await fetchBytes(fx.server, MANIFEST_FILE);
    assert.equal(m.status, 200, "remaining files must still be served");
  } finally {
    await fx.server.stop();
  }
}

/** The distinctness assertions of the sandbox tooth, standalone for known-red. */
export function assertSandboxDistinct(
  a: { dir: string; port: number },
  b: { dir: string; port: number },
): void {
  assert.notEqual(a.dir, b.dir, "two live sandboxes must have distinct dirs");
  assert.notEqual(a.port, b.port, "two live sandboxes must have distinct ports");
}

export async function assertDirGone(dir: string): Promise<void> {
  await assert.rejects(fs.access(dir), "teardown must remove the sandbox dir");
}

export async function checkSandboxIsolation(ctx: ToothContext): Promise<void> {
  const a = await createSandbox({ prefix: "iso-a", baseDir: ctx.sandboxDir });
  const b = await createSandbox({ prefix: "iso-b", baseDir: ctx.sandboxDir });
  try {
    assertSandboxDistinct(a, b);
    await assertDirGone(path.join(a.dir, "does-not-exist")); // sanity: helper works
  } finally {
    await a.teardown();
    await b.teardown();
  }
  await assertDirGone(a.dir);
  await assertDirGone(b.dir);
}

/**
 * Sandbox verify-dead check lives with the sandbox module (its domain):
 * re-exported here so the M0 teeth and tests import from one place.
 */
export { checkSandboxVerifyDead } from "../scenario/sandbox.ts";

// ---------------------------------------------------------------------------
// Registered teeth (must-red answered per "who else would catch this?").
// ---------------------------------------------------------------------------

