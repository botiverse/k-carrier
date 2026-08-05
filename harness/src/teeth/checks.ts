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
 * The chain verifier used here is the harness's own (keychain.ts): the
 * "downstream validation tooth" of test-plan M0 is literally these checks
 * until core distsign lands and mirrors the same shape.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type ToothContext } from "./registry.ts";
import { FakeServer, type PublishedRelease } from "../fake-server/server.ts";
import {
  createKeychain,
  verifyChain,
  type TestKeychain,
} from "../fake-server/keychain.ts";
import {
  MANIFEST_FILE,
  SIGNING_PUB_FILE,
  SIGNING_PUB_SIG_FILE,
  sigFileFor,
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
  keychain: TestKeychain;
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
  const keychain = createKeychain();
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store"), keychain });
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
    keychain,
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
 * Verify `data`+`sig` through the chain as SERVED: signing.pub and its
 * root signature are fetched from the server, not taken from local state —
 * a tampered signing.pub would fail here too.
 */
export async function verifyServed(
  fx: ReleaseFixture,
  data: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  const pub = await fetchBytes(fx.server, SIGNING_PUB_FILE);
  const pubSig = await fetchBytes(fx.server, SIGNING_PUB_SIG_FILE);
  if (pub.status !== 200 || pubSig.status !== 200) return false;
  return verifyChain({
    root: fx.keychain.root,
    signingPub: pub.body,
    signingPubSig: pubSig.body,
    data,
    dataSig: sig,
  });
}

// ---------------------------------------------------------------------------
// Checks (exported for known-red driving). Each throws on violation.
// ---------------------------------------------------------------------------

export async function checkServesVerifiableRelease(
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
    assert.deepEqual(art.body, fx.artifactBytes);
    assert.equal(sha256Hex(art.body), target.sha256, "served bytes must match manifest sha256");

    const mSig = await fetchBytes(fx.server, sigFileFor(MANIFEST_FILE));
    assert.equal(mSig.status, 200, "manifest signature must be served");
    assert.equal(
      await verifyServed(fx, m.body, mSig.body),
      true,
      "manifest must verify through the served chain",
    );
    const aSig = await fetchBytes(fx.server, sigFileFor(fx.artifact));
    assert.equal(aSig.status, 200, "artifact signature must be served");
    assert.equal(
      await verifyServed(fx, art.body, aSig.body),
      true,
      "artifact must verify through the served chain",
    );
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
    const art = await fetchBytes(fx.server, fx.artifact);
    const sig = await fetchBytes(fx.server, sigFileFor(fx.artifact));
    assert.equal(
      await verifyServed(fx, art.body, sig.body),
      false,
      "corrupted artifact must FAIL signature verification",
    );
    // isolation: untouched files must still verify
    const m = await fetchBytes(fx.server, MANIFEST_FILE);
    const mSig = await fetchBytes(fx.server, sigFileFor(MANIFEST_FILE));
    assert.equal(
      await verifyServed(fx, m.body, mSig.body),
      true,
      "untampered files must still verify",
    );
  } finally {
    await fx.server.stop();
  }
}

export async function checkSwapSigRejects(
  ctx: ToothContext,
  mutate?: (server: FakeServer) => Promise<void>,
): Promise<void> {
  const fx = await setupRelease(ctx, {
    artifacts: { [M0_ARTIFACT]: PAYLOAD, [M0_ARTIFACT_B]: "K fake-server payload B" },
    binary: M0_ARTIFACT,
  });
  try {
    if (mutate) await mutate(fx.server);
    else {
      await fx.server.swapSig(sigFileFor(M0_ARTIFACT), sigFileFor(M0_ARTIFACT_B));
    }
    for (const name of [M0_ARTIFACT, M0_ARTIFACT_B]) {
      const art = await fetchBytes(fx.server, name);
      const sig = await fetchBytes(fx.server, sigFileFor(name));
      assert.equal(
        await verifyServed(fx, art.body, sig.body),
        false,
        `swapped signature for ${name} must FAIL verification`,
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
  const keychain = createKeychain();
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store"), keychain });
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

// ---------------------------------------------------------------------------
// Registered teeth (must-red answered per "who else would catch this?").
// ---------------------------------------------------------------------------

