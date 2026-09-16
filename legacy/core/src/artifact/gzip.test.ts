// @invariant — gzip is optional transport; only canonical verified bytes reach staging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadVerified, partialPathFor } from "./download.ts";
import type { Release } from "./source.ts";

const raw = Buffer.from("service binary".repeat(100));
const compressed = gzipSync(raw);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const release: Release = {
  version: "2.0.0", url: "https://example.test/app", size: raw.length, sha256: sha(raw),
  gzip: { url: "https://example.test/app.gz", size: compressed.length, sha256: sha(compressed) },
};

test("gzip declared: request compressed URL and return canonical executable bytes", async () => {
  const calls: string[] = [];
  const bytes = await downloadVerified(release, { fetchImpl: async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("accept-encoding"), "identity");
    return new Response(compressed);
  } });
  assert.deepEqual(Buffer.from(bytes), raw);
  assert.deepEqual(calls, [release.gzip!.url]);
});

test("no gzip declared: preserve raw path without requesting a guessed gzip URL", async () => {
  const { gzip: _gzip, ...plain } = release;
  const bytes = await downloadVerified(plain, { fetchImpl: async (url) => {
    assert.equal(url, release.url);
    return new Response(raw);
  } });
  assert.deepEqual(Buffer.from(bytes), raw);
});

test("gzip corrupt identity or decode failure never silently falls back to raw", async () => {
  for (const [candidate, body, error] of [
    [release, Buffer.from("tampered"), /SHA256_MISMATCH/],
    [{ ...release, gzip: { ...release.gzip!, size: 3, sha256: sha(Buffer.from("bad")) } }, Buffer.from("bad"), /gzip is invalid/],
    [{ ...release, sha256: "0".repeat(64) }, compressed, /SHA256_MISMATCH/],
    [{ ...release, size: raw.length + 1 }, compressed, /SIZE_MISMATCH/],
    [{ ...release, size: 4 }, compressed, /exceeds the declared/],
  ] as const) {
    let calls = 0;
    await assert.rejects(downloadVerified(candidate, { fetchImpl: async (url) => {
      calls++;
      assert.equal(url, candidate.gzip!.url);
      return new Response(body);
    } }), error);
    assert.equal(calls, 1);
  }
});

test("gzip metadata must be complete before any download", async () => {
  await assert.rejects(downloadVerified({ ...release, gzip: { ...release.gzip!, size: -1 } }, {
    fetchImpl: async () => { assert.fail("invalid metadata reached network"); },
  }), /MANIFEST_INVALID/);
});

test("interrupted gzip resumes compressed offsets and verifies decoded result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "k-gzip-"));
  const prefix = compressed.subarray(0, 12);
  try {
    await assert.rejects(downloadVerified(release, { resumeDir: dir, fetchImpl: async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(prefix); },
        pull(controller) { controller.error(new Error("connection lost")); },
      })) }), /connection lost|DOWNLOAD_FAILED/);
    const partial = partialPathFor(dir, release.gzip!.url);
    // The disk prefix, not decoded bytes, determines the next Range.
    assert.deepEqual(await readFile(partial), prefix);
    const result = await downloadVerified(release, { resumeDir: dir, fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("range"), `bytes=${prefix.length}-`);
      return new Response(compressed.subarray(prefix.length), { status: 206,
        headers: { "Content-Range": `bytes ${prefix.length}-${compressed.length - 1}/${compressed.length}` } });
    } });
    assert.deepEqual(Buffer.from(result), raw);
    await writeFile(partial, prefix);
    await assert.rejects(downloadVerified({ ...release, sha256: "0".repeat(64) }, {
      resumeDir: dir, fetchImpl: async () => new Response(compressed),
    }), /SHA256_MISMATCH/);
    await assert.rejects(readFile(partial), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
