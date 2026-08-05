// @invariant — artifact-factory: build-once stamp-many, deterministic
// releases, deliberate-behavior knobs, content-addressed cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ArtifactFactory, artifactFileName, stamp, type Behavior } from "./factory.ts";
import { DEMO_SOURCE } from "./demo.ts";
import { ReleaseStore } from "../fake-server/store.ts";
import { createKeychain } from "../fake-server/keychain.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import { runArtifact } from "./run.ts";
import { MANIFEST_FILE, sigFileFor } from "../fake-server/manifest.ts";

async function withSandbox<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const sb = await createSandbox({ prefix: "factory" });
  try {
    return await fn(sb.dir);
  } finally {
    await sb.teardown();
  }
}

function storeFor(dir: string, name: string): ReleaseStore {
  return new ReleaseStore(path.join(dir, name), createKeychain());
}

test("stamp injects version and behavior into the artifact bytes", () => {
  const bytes = stamp(DEMO_SOURCE, "1.2.3", "ok");
  const src = new TextDecoder().decode(bytes);
  assert.match(src, /const VERSION = "1\.2\.3"/);
  assert.match(src, /const BEHAVIOR = "ok"/);
  assert.ok(!src.includes("__K_VERSION__"));
  assert.ok(!src.includes("__K_BEHAVIOR__"));
});

test("makeRelease publishes artifact + manifest + chain into the store", async () => {
  await withSandbox(async (dir) => {
    const factory = new ArtifactFactory({ cacheDir: path.join(dir, "cache") });
    const store = storeFor(dir, "store");
    const rel = await factory.makeRelease({ version: "1.0.0", behavior: "ok", store });
    assert.equal(rel.artifactFile, artifactFileName("1.0.0"));
    assert.equal(store.active, "1.0.0");
    assert.ok(store.has("1.0.0"));
    // manifest + artifact + chain are all served from the store
    const manifest = JSON.parse(new TextDecoder().decode(await store.readFile(MANIFEST_FILE)));
    assert.equal(manifest.version, "1.0.0");
    assert.deepEqual(await store.readFile(rel.artifactFile), rel.artifactBytes);
    await store.readFile(sigFileFor(rel.artifactFile)); // exists, signed
    // published artifact is executable
    const mode = (await fs.stat(path.join(dir, "store", "releases", "1.0.0", rel.artifactFile))).mode;
    assert.ok(mode & 0o100, "artifact must be executable");
  });
});

test("ok artifact really runs and reports its stamped version", async () => {
  await withSandbox(async (dir) => {
    const factory = new ArtifactFactory({ cacheDir: path.join(dir, "cache") });
    const store = storeFor(dir, "store");
    const rel = await factory.makeRelease({ version: "2.1.0", behavior: "ok", store });
    const artifactPath = path.join(dir, "store", "releases", "2.1.0", rel.artifactFile);
    const r = await runArtifact(artifactPath);
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "2.1.0 ready");
  });
});

test("behavior knobs produce genuinely broken binaries", async () => {
  await withSandbox(async (dir) => {
    const factory = new ArtifactFactory({ cacheDir: path.join(dir, "cache") });
    const behaviors: Array<{ behavior: Behavior; expectCode: number | null; expectOut: string; timeoutMs: number }> = [
      // non-hang behaviors get a generous timeout: under parallel load a
      // 1s window can kill a healthy process before it exits
      { behavior: "crash-on-start", expectCode: 1, expectOut: "3.0.0 ready", timeoutMs: 10000 },
      { behavior: "wrong-version-probe", expectCode: 0, expectOut: "9.9.9 ready", timeoutMs: 10000 },
      { behavior: "hang-on-quiesce", expectCode: null, expectOut: "3.0.0 ready", timeoutMs: 1000 }, // killed by timeout
    ];
    for (const { behavior, expectCode, expectOut, timeoutMs } of behaviors) {
      const store = storeFor(dir, `store-${behavior}`);
      const rel = await factory.makeRelease({ version: "3.0.0", behavior, store });
      const artifactPath = path.join(dir, `store-${behavior}`, "releases", "3.0.0", rel.artifactFile);
      const r = await runArtifact(artifactPath, timeoutMs);
      assert.equal(r.timedOut, behavior === "hang-on-quiesce", `${behavior}: hang must time out`);
      assert.equal(r.code, expectCode, `${behavior}: exit code`);
      assert.equal(r.stdout.trim(), expectOut, `${behavior}: reported version`);
    }
  });
});

test("content-addressed cache: same key reuses, different key rebuilds", async () => {
  await withSandbox(async (dir) => {
    const factory = new ArtifactFactory({ cacheDir: path.join(dir, "cache") });
    const store = storeFor(dir, "store");
    const a = await factory.makeRelease({ version: "1.0.0", behavior: "ok", store });
    assert.equal(a.cached, false);
    assert.equal(factory.builds, 1);
    const b = await factory.makeRelease({ version: "1.0.0", behavior: "ok", store });
    assert.equal(b.cached, true, "same key must hit the cache");
    assert.equal(factory.builds, 1, "cache hit must not rebuild");
    assert.deepEqual(b.artifactBytes, a.artifactBytes);
    const c = await factory.makeRelease({ version: "1.0.0", behavior: "crash-on-start", store: storeFor(dir, "store2") });
    assert.equal(c.cached, false, "different behavior is a different key");
    assert.equal(factory.builds, 2);
    assert.notDeepEqual(c.artifactBytes, a.artifactBytes, "different behavior must produce different bytes");
  });
});

test("stamping is deterministic across two factories with fresh caches", async () => {
  await withSandbox(async (dir) => {
    const fa = new ArtifactFactory({ cacheDir: path.join(dir, "cache-a") });
    const fb = new ArtifactFactory({ cacheDir: path.join(dir, "cache-b") });
    const keychain = createKeychain();
    const sa = new ReleaseStore(path.join(dir, "sa"), keychain);
    const sb = new ReleaseStore(path.join(dir, "sb"), keychain);
    const a = await fa.makeRelease({ version: "1.0.0", behavior: "ok", store: sa });
    const b = await fb.makeRelease({ version: "1.0.0", behavior: "ok", store: sb });
    assert.deepEqual(b.artifactBytes, a.artifactBytes);
    // Same keychain + deterministic stamping => Ed25519 signatures match too
    const sigA = await sa.readFile(sigFileFor(a.artifactFile));
    const sigB = await sb.readFile(sigFileFor(b.artifactFile));
    assert.deepEqual(sigB, sigA);
  });
});
