// @invariant — the release-source boundary: K asks two questions and holds no
// versioning policy of its own; the default source's policy is ITS policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { staticManifestSource } from "./staticManifestSource.ts";
import type { ReleaseContext, ReleaseSource, Release } from "./source.ts";

const SHA = "a".repeat(64);
const ctx: ReleaseContext = { currentVersion: "1.0.0", platformKey: "linux-x64" };

function manifestJson(version: string): string {
  return JSON.stringify({
    version,
    targets: { "linux-x64": { file: `app-${version}.bin`, sha256: SHA, size: 10 } },
  });
}

function sourceServing(version: string): ReleaseSource {
  return staticManifestSource({
    baseUrl: "https://cdn.example/mytool/stable",
    fetchImpl: (async () =>
      new Response(manifestJson(version), { status: 200 })) as unknown as typeof fetch,
  });
}

test("checkForUpdate returns a complete release when the source serves something newer", async () => {
  const release = await sourceServing("1.2.0").checkForUpdate(ctx);
  assert.ok(release);
  assert.deepEqual(release, {
    version: "1.2.0",
    url: "https://cdn.example/mytool/stable/app-1.2.0.bin",
    sha256: SHA,
    size: 10,
  } satisfies Release);
});

test("checkForUpdate returns null when there is nothing to do", async () => {
  assert.equal(await sourceServing("1.0.0").checkForUpdate(ctx), null);
});

test("the default source refuses to call an older version an update (no automatic downgrade)", async () => {
  assert.equal(await sourceServing("0.9.0").checkForUpdate(ctx), null);
});

test("fetchRelease serves a named version — the explicit path, including downgrade", async () => {
  // Same source, older version, asked for BY NAME: allowed, because explicit.
  const release = await sourceServing("0.9.0").fetchRelease("0.9.0", ctx);
  assert.equal(release.version, "0.9.0");
  assert.equal(release.url, "https://cdn.example/mytool/stable/app-0.9.0.bin");
});

test("fetchRelease fails closed when the source cannot serve the named version", async () => {
  await assert.rejects(
    () => sourceServing("1.2.0").fetchRelease("9.9.9", ctx),
    /PINNED_VERSION_MISMATCH/u,
  );
});

test("an unsupported platform fails closed rather than guessing a target", async () => {
  await assert.rejects(
    () => sourceServing("1.2.0").checkForUpdate({ ...ctx, platformKey: "sparc-solaris" }),
    /UNSUPPORTED_PLATFORM/u,
  );
});

test("a custom source needs no K concepts: channels and pinning live inside it", async () => {
  // Proof that the interface does not force K's vocabulary on an adopter:
  // this source uses date versions and its own "channel", and K neither
  // knows nor cares.
  const dateSource: ReleaseSource = {
    async checkForUpdate(c) {
      const nightly = "2026.08.05";
      return c.currentVersion === nightly
        ? null
        : { version: nightly, url: `https://x/nightly/${c.platformKey}.bin`, sha256: SHA, size: 1 };
    },
    async fetchRelease(version, c) {
      return { version, url: `https://x/archive/${version}/${c.platformKey}.bin`, sha256: SHA, size: 1 };
    },
  };
  const r = await dateSource.checkForUpdate({ currentVersion: "2026.08.01", platformKey: "linux-x64" });
  assert.equal(r?.version, "2026.08.05");
  assert.equal(await dateSource.checkForUpdate({ currentVersion: "2026.08.05", platformKey: "linux-x64" }), null);
});
