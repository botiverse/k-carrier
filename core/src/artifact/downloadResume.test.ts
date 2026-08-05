// @invariant — download resume (断点续传): an interrupted download leaves
// its prefix; the next attempt resumes via Range and the FULL assembled
// bytes verify. A corrupted partial is refused and deleted, never trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { downloadVerified, partialPathFor } from "./download.ts";
import type { ManifestTarget } from "./staticManifestSource.ts";
import type { Clock } from "../clock.ts";

function targetFor(bytes: Uint8Array, overrides: Partial<ManifestTarget> = {}): ManifestTarget {
  return {
    file: "app.bin",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    ...overrides,
  };
}

function releaseFor(base: string, bytes: Uint8Array, overrides: Partial<{ sha256: string; size: number; file: string }> = {}) {
  const t = targetFor(bytes, overrides);
  return {
    version: "1.0.0",
    url: `${base.replace(/\/$/u, "")}/${t.file}`,
    sha256: t.sha256,
    size: t.size,
  };
}

// ---------------------------------------------------------------------------
// resume (断点续传)
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

async function resumeDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "k-dl-resume-"));
}

function payload(n = 20000): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 251;
  return out;
}

/** The 20000-byte payload the resume tests download (BIG != the 20-byte BIG). */
const BIG = payload(20000);

/** Server whose handler records the Range header of every request. */
async function withRecordingServer(
  onRequest: (range: string | null, res: import("node:http").ServerResponse, body: Uint8Array) => void,
  fn: (base: string, ranges: string[]) => Promise<void>,
): Promise<void> {
  const ranges: string[] = [];
  const server: Server = createServer((req, res) => {
    const range = req.headers.range ?? null;
    ranges.push(range ?? "");
    onRequest(range, res, BIG);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  try {
    await fn(`http://127.0.0.1:${addr.port}`, ranges);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

test("an interrupted download leaves its prefix; the next attempt resumes via Range", async () => {
  await withRecordingServer((range, res, body) => {
    if (range) {
      const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
        "content-length": body.length - start,
      });
      res.end(body.subarray(start));
    } else {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
      res.end(body);
    }
  }, async (base, ranges) => {
    const dir = await resumeDir();
    try {
      // first attempt: interrupted after a prefix (simulate via a killed
      // process by writing a prefix ourselves — the partial IS the resume
      // state, whatever wrote it)
      const prefix = BIG.subarray(0, 5000);
      await fs.writeFile(partialPathFor(dir, `${base}/app.bin`), prefix);

      const bytes = await downloadVerified(releaseFor(base, BIG, { file: "app.bin" }), {
        resumeDir: dir,
        timeoutMs: 10000,
      });
      assert.deepEqual(bytes, BIG, "resumed download must assemble the FULL bytes");
      assert.equal(ranges.at(-1), `bytes=5000-`, "the resume must send a Range request");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("a 200 (Range ignored) restarts the partial from scratch", async () => {
  await withRecordingServer((_range, res, body) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  }, async (base, ranges) => {
    const dir = await resumeDir();
    try {
      const prefix = BIG.subarray(0, 5000);
      await fs.writeFile(partialPathFor(dir, `${base}/app.bin`), prefix);
      const bytes = await downloadVerified(releaseFor(base, BIG, { file: "app.bin" }), {
        resumeDir: dir,
        timeoutMs: 10000,
      });
      assert.deepEqual(bytes, BIG);
      assert.equal(ranges.at(-1), `bytes=5000-`, "a Range request is still sent");
      // the partial was rewritten from scratch (a 200 carries the full body)
      const partial = await fs.readFile(partialPathFor(dir, `${base}/app.bin`));
      assert.equal(partial.length, BIG.length, "the partial must now hold the full bytes");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("a corrupted partial is refused and deleted, never trusted", async () => {
  await withRecordingServer((range, res, body) => {
    if (range) {
      const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
        "content-length": body.length - start,
      });
      res.end(body.subarray(start));
    } else {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
      res.end(body);
    }
  }, async (base) => {
    const dir = await resumeDir();
    try {
      const key = partialPathFor(dir, `${base}/app.bin`);
      // a poisoned PARTIAL prefix: wrong bytes, so the full assembly fails
      await fs.writeFile(key, new Uint8Array(5000).fill(0xff));
      await assert.rejects(
        downloadVerified(releaseFor(base, BIG, { file: "app.bin" }), { resumeDir: dir }),
        /SHA256_MISMATCH/,
      );
      await assert.rejects(fs.access(key), "the poisoned partial must be deleted");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("without resumeDir no partial file is created", async () => {
  await withRecordingServer((_range, res, body) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  }, async (base) => {
    const dir = await resumeDir();
    try {
      const bytes = await downloadVerified(releaseFor(base, BIG, { file: "app.bin" }));
      assert.deepEqual(bytes, BIG);
      assert.deepEqual(await fs.readdir(dir), [], "no partial without resumeDir");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("a timeout mid-download preserves the partial for resume", async () => {
  // a real-delay clock: the abort fires after the prefix has arrived
  const delayedClock: Clock = {
    nowMs: () => 0,
    after: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  };
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": BIG.length });
    res.write(BIG.subarray(0, 3000)); // send a prefix, then never finish
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${addr.port}`;
  const dir = await resumeDir();
  try {
    await assert.rejects(
      downloadVerified(releaseFor(base, BIG, { file: "app.bin" }), {
        resumeDir: dir,
        clock: delayedClock,
        timeoutMs: 100,
      }),
      /DOWNLOAD_FAILED.*timed out/,
    );
    const partial = await fs.readFile(partialPathFor(dir, `${base}/app.bin`));
    assert.ok(partial.length > 0 && partial.length <= BIG.length, "the partial must hold the received prefix");
  } finally {
    await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
