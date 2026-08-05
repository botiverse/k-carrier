// @invariant — fake-server serving + tamper semantics: real HTTP, real
// bytes; a tamper must be observable by a real client fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { FakeServer } from "./server.ts";
import { createKeychain, verifyChain, type TestKeychain } from "./keychain.ts";
import {
  MANIFEST_FILE,
  SIGNING_PUB_FILE,
  SIGNING_PUB_SIG_FILE,
  sigFileFor,
  compareVersions,
  type Manifest,
} from "./manifest.ts";
import { createSandbox } from "../scenario/sandbox.ts";

const PAYLOAD = "fake-server unit payload";

async function withServer(
  fn: (s: FakeServer, kc: TestKeychain, dir: string) => Promise<void>,
): Promise<void> {
  const sb = await createSandbox({ prefix: "fake-server" });
  const kc = createKeychain();
  const server = new FakeServer({ storeDir: path.join(sb.dir, "store"), keychain: kc });
  await server.start();
  try {
    await fn(server, kc, sb.dir);
  } finally {
    await server.stop();
    await sb.teardown();
  }
}

async function get(server: FakeServer, file: string): Promise<{ status: number; body: Uint8Array }> {
  const res = await fetch(`${server.url}/${file}`);
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
}

function chainVerify(kc: TestKeychain, pub: Uint8Array, pubSig: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean {
  return verifyChain({ root: kc.root, signingPub: pub, signingPubSig: pubSig, data, dataSig: sig });
}

test("serves manifest, artifacts and the full signature chain", async () => {
  await withServer(async (s, kc) => {
    await s.publishRelease({
      version: "1.0.0",
      artifacts: { "app-1.0.0.bin": PAYLOAD },
      platform: "darwin-arm64",
    });
    assert.equal(s.active, "1.0.0");
    const m = await get(s, MANIFEST_FILE);
    assert.equal(m.status, 200);
    const manifest = JSON.parse(new TextDecoder().decode(m.body)) as Manifest;
    assert.equal(manifest.version, "1.0.0");
    const target = manifest.targets["darwin-arm64"];
    assert.ok(target);
    assert.equal(target.file, "app-1.0.0.bin");

    const art = await get(s, "app-1.0.0.bin");
    assert.equal(art.status, 200);
    assert.equal(new TextDecoder().decode(art.body), PAYLOAD);

    const pub = await get(s, SIGNING_PUB_FILE);
    const pubSig = await get(s, SIGNING_PUB_SIG_FILE);
    const aSig = await get(s, sigFileFor("app-1.0.0.bin"));
    assert.equal(pub.status, 200);
    assert.equal(pubSig.status, 200);
    assert.equal(aSig.status, 200);
    assert.equal(chainVerify(kc, pub.body, pubSig.body, art.body, aSig.body), true);
  });
});

test("unknown file and non-GET methods behave (404 / 405)", async () => {
  await withServer(async (s) => {
    await s.publishRelease({ version: "1.0.0", artifacts: { "a.bin": "x" } });
    assert.equal((await get(s, "nope.bin")).status, 404);
    const res = await fetch(`${s.url}/a.bin`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal((await get(s, "")).status, 404); // root has no index
  });
});

test("corruptByte flips exactly one byte; out-of-range throws", async () => {
  await withServer(async (s) => {
    await s.publishRelease({ version: "1.0.0", artifacts: { "a.bin": "hello" } });
    await s.corruptByte("a.bin", 0);
    const art = await get(s, "a.bin");
    assert.equal(art.body[0], 0x68 ^ 0xff); // 'h' (0x68) XOR 0xff
    assert.equal(new TextDecoder().decode(art.body.slice(1)), "ello");
    await assert.rejects(s.corruptByte("a.bin", 100), RangeError);
    await assert.rejects(s.corruptByte("a.bin", -1), RangeError);
  });
});

test("corruptByte twice on the same offset restores the byte (a real property of the op)", async () => {
  await withServer(async (s) => {
    await s.publishRelease({ version: "1.0.0", artifacts: { "a.bin": "hello" } });
    await s.corruptByte("a.bin", 1);
    const once = await get(s, "a.bin");
    await s.corruptByte("a.bin", 1);
    const twice = await get(s, "a.bin");
    assert.equal(once.body[1], 0x65 ^ 0xff); // 'e' (0x65) XOR 0xff
    assert.equal(new TextDecoder().decode(twice.body), "hello");
  });
});

test("swapSig cross-swaps two signature files; restore() undoes tamper", async () => {
  await withServer(async (s, kc) => {
    await s.publishRelease({
      version: "1.0.0",
      artifacts: { "a.bin": "aaaa", "b.bin": "bbbb" },
      binary: "a.bin",
    });
    await s.swapSig(sigFileFor("a.bin"), sigFileFor("b.bin"));
    const pub = await get(s, SIGNING_PUB_FILE);
    const pubSig = await get(s, SIGNING_PUB_SIG_FILE);
    const a = await get(s, "a.bin");
    const b = await get(s, "b.bin");
    // a.bin now carries b.bin's signature -> neither verifies
    assert.equal(
      chainVerify(kc, pub.body, pubSig.body, a.body, (await get(s, sigFileFor("a.bin"))).body),
      false,
    );
    assert.equal(
      chainVerify(kc, pub.body, pubSig.body, b.body, (await get(s, sigFileFor("b.bin"))).body),
      false,
    );
    await s.restore();
    assert.equal(
      chainVerify(kc, pub.body, pubSig.body, a.body, (await get(s, sigFileFor("a.bin"))).body),
      true,
    );
    assert.equal(
      chainVerify(kc, pub.body, pubSig.body, b.body, (await get(s, sigFileFor("b.bin"))).body),
      true,
    );
  });
});

test("serveOlderVersion switches to the strictly-older release; no older -> throws", async () => {
  await withServer(async (s) => {
    await s.publishRelease({ version: "1.0.0", artifacts: { "app-1.0.0.bin": "v1" } });
    await s.publishRelease({ version: "2.0.0", artifacts: { "app-2.0.0.bin": "v2" } });
    assert.equal(s.active, "2.0.0");
    const older = await s.serveOlderVersion();
    assert.equal(older, "1.0.0");
    assert.equal(s.active, "1.0.0");
    const m = await get(s, MANIFEST_FILE);
    const manifest = JSON.parse(new TextDecoder().decode(m.body)) as Manifest;
    assert.equal(compareVersions(manifest.version, "2.0.0"), -1);
    assert.equal((await get(s, "app-1.0.0.bin")).status, 200);
    await assert.rejects(s.serveOlderVersion(), /no older release/); // nothing older than 1.0.0
  });
});

test("dropFile removes exactly that file; restore() brings it back", async () => {
  await withServer(async (s) => {
    await s.publishRelease({
      version: "1.0.0",
      artifacts: { "a.bin": "aaaa", "b.bin": "bbbb" },
      binary: "a.bin",
    });
    await s.dropFile("b.bin");
    assert.equal((await get(s, "b.bin")).status, 404);
    assert.equal((await get(s, "a.bin")).status, 200);
    await s.restore();
    assert.equal((await get(s, "b.bin")).status, 200);
  });
});

test("publishing the same version twice fails; multiple artifacts need explicit binary", async () => {
  await withServer(async (s) => {
    await s.publishRelease({ version: "1.0.0", artifacts: { "a.bin": "x" } });
    await assert.rejects(
      s.publishRelease({ version: "1.0.0", artifacts: { "a.bin": "y" } }),
      /already published/,
    );
    await assert.rejects(
      s.publishRelease({ version: "2.0.0", artifacts: { "a.bin": "x", "b.bin": "y" } }),
      /specify which/,
    );
  });
});

test("request paths cannot escape the release root (encoded traversal)", async () => {
  await withServer(async (s) => {
    await s.publishRelease({ version: "1.0.0", artifacts: { "a.bin": "x" } });
    // %2e%2e%2f = "../" — must be rejected by the server, not served
    const res = await fetch(`${s.url}/..%2fstore%2freleases%2f1.0.0%2fa.bin`);
    assert.equal(res.status, 404);
  });
});

test("dropFile of the manifest removes it from disk inside the sandbox", async () => {
  await withServer(async (s, _kc, dir) => {
    await s.publishRelease({ version: "1.0.0", artifacts: { "a.bin": "x" } });
    await s.dropFile(MANIFEST_FILE);
    assert.equal((await get(s, MANIFEST_FILE)).status, 404);
    await assert.rejects(fs.access(path.join(dir, "store", "releases", "1.0.0", MANIFEST_FILE)));
  });
});
