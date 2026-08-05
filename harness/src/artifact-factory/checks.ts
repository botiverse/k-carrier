/**
 * artifact-factory acceptance checks — run bodies of the factory teeth
 * (registered in teeth/artifactFactory.ts). Each throws on violation.
 *
 * The two acceptance claims (harness-design §1.77):
 *  - determinism: same (version, behavior) builds byte-identical artifacts
 *    — and since Ed25519 is deterministic, the whole published release
 *    (artifact + manifest + signatures) reproduces exactly;
 *  - the ok artifact is a REAL binary: it runs and reports the stamped
 *    version (this is what makes "升到坏版本→自动回滚" black-box testable).
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { type ToothContext } from "../teeth/registry.ts";
import { ArtifactFactory, type Behavior } from "./factory.ts";
import { runArtifact } from "./run.ts";
import { ReleaseStore } from "../fake-server/store.ts";
import { createKeychain } from "../fake-server/keychain.ts";
import { MANIFEST_FILE, sigFileFor } from "../fake-server/manifest.ts";

function storeFor(dir: string, name: string, keychain?: ReturnType<typeof createKeychain>): ReleaseStore {
  return new ReleaseStore(path.join(dir, name), keychain ?? createKeychain());
}

/**
 * Two independent factories (fresh caches) with the same input must produce
 * byte-identical artifacts, signatures and manifests. `secondFactory`
 * overrides factory B for known-red driving.
 */
export async function checkDeterministicBuild(
  ctx: ToothContext,
  secondFactory?: ArtifactFactory,
): Promise<void> {
  const factoryA = new ArtifactFactory({ cacheDir: path.join(ctx.sandboxDir, "cache-a") });
  const factoryB = secondFactory ?? new ArtifactFactory({ cacheDir: path.join(ctx.sandboxDir, "cache-b") });
  const keychain = createKeychain();
  const storeA = storeFor(ctx.sandboxDir, "store-a", keychain);
  const storeB = storeFor(ctx.sandboxDir, "store-b", keychain);
  const a = await factoryA.makeRelease({ version: "2.0.0", behavior: "ok", store: storeA });
  const b = await factoryB.makeRelease({ version: "2.0.0", behavior: "ok", store: storeB });
  assert.deepEqual(
    b.artifactBytes,
    a.artifactBytes,
    "same version+behavior must stamp byte-identical artifacts",
  );
  const sigA = await storeA.readFile(sigFileFor(a.artifactFile));
  const sigB = await storeB.readFile(sigFileFor(b.artifactFile));
  assert.deepEqual(sigB, sigA, "signatures must be deterministic (Ed25519)");
  const manifestA = await storeA.readFile(MANIFEST_FILE);
  const manifestB = await storeB.readFile(MANIFEST_FILE);
  assert.deepEqual(manifestB, manifestA, "manifests must be byte-identical");
}

/**
 * The ok artifact must be a real executable that runs and reports its
 * stamped version. `behavior` overrides the build knob for known-red
 * driving (a broken build behaves exactly like a must-red mutation).
 */
export async function checkOkArtifactRuns(ctx: ToothContext, behavior: Behavior = "ok"): Promise<void> {
  const factory = new ArtifactFactory({ cacheDir: path.join(ctx.sandboxDir, "cache") });
  const store = storeFor(ctx.sandboxDir, "store");
  const version = "1.2.3";
  const rel = await factory.makeRelease({ version, behavior, store });
  const artifactPath = path.join(ctx.sandboxDir, "store", "releases", version, rel.artifactFile);
  const r = await runArtifact(artifactPath);
  assert.equal(r.timedOut, false, "ok artifact must not hang");
  assert.equal(r.code, 0, "ok artifact must exit 0");
  assert.equal(
    r.stdout.trim(),
    `${version} ready`,
    "ok artifact must report the stamped version",
  );
}
