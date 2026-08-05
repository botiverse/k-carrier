// @invariant — L0 download integrity: bytes are verified against the
// manifest's sha256 + size before they are ever returned; tampered or
// truncated artifacts are refused, and a hung download aborts via the
// injected clock instead of hanging the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { downloadVerified } from "./download.ts";
import type { ManifestTarget } from "./manifest.ts";
import type { Clock } from "../clock.ts";

const PAYLOAD = new TextEncoder().encode("K artifact payload");

/** Build the Release a source would have returned for these bytes. */
function releaseFor(base: string, bytes: Uint8Array, overrides: Partial<{ sha256: string; size: number; file: string }> = {}) {
  const t = targetFor(bytes, overrides);
  return {
    version: "1.0.0",
    url: `${base.replace(/\/$/u, "")}/${t.file}`,
    sha256: overrides.sha256 ?? t.sha256,
    size: overrides.size ?? t.size,
  };
}

function targetFor(bytes: Uint8Array, overrides: Partial<ManifestTarget> = {}): ManifestTarget {
  return {
    file: "app.bin",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    ...overrides,
  };
}

async function withServer(
  routes: Record<string, { status?: number; body?: Uint8Array; never?: boolean }>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const route = routes[req.url ?? "/"];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    if (route.never) return; // never respond: for timeout tests
    res.writeHead(route.status ?? 200);
    res.end(route.body ?? new Uint8Array(0));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/** Clock stub whose timers fire immediately (timeout at t=0). */
const immediateClock: Clock = {
  nowMs: () => 0,
  after: (_ms, fn) => {
    fn();
    return () => {};
  },
};

test("downloads and verifies a matching artifact", async () => {
  await withServer({ "/app.bin": { body: PAYLOAD } }, async (base) => {
    const bytes = await downloadVerified(releaseFor(base, PAYLOAD));
    assert.deepEqual(bytes, PAYLOAD);
  });
});

test("refuses a tampered artifact (sha256 mismatch)", async () => {
  const tampered = PAYLOAD.slice();
  const first = tampered[0];
  if (first === undefined) throw new Error("payload empty");
  tampered[0] = first ^ 0xff;
  await withServer({ "/app.bin": { body: tampered } }, async (base) => {
    await assert.rejects(
      downloadVerified(releaseFor(base, PAYLOAD)),
      /SHA256_MISMATCH/,
    );
  });
});

test("refuses a truncated artifact (sha256 mismatch catches it)", async () => {
  await withServer({ "/app.bin": { body: PAYLOAD.slice(0, 4) } }, async (base) => {
    await assert.rejects(downloadVerified(releaseFor(base, PAYLOAD)), /SHA256_MISMATCH/);
  });
});

test("refuses when the manifest's declared size disagrees (SIZE_MISMATCH cross-check)", async () => {
  // same bytes (sha matches) but the manifest lies about the size
  await withServer({ "/app.bin": { body: PAYLOAD } }, async (base) => {
    await assert.rejects(
      downloadVerified(releaseFor(base, PAYLOAD, { size: PAYLOAD.length + 1 })),
      /SIZE_MISMATCH/,
    );
  });
});

test("a missing file is a typed DOWNLOAD_FAILED, not a hang", async () => {
  await withServer({}, async (base) => {
    await assert.rejects(downloadVerified(releaseFor(base, PAYLOAD)), /DOWNLOAD_FAILED.*404/);
  });
});

test("a hung download aborts via the clock timeout", async () => {
  await withServer({ "/app.bin": { never: true } }, async (base) => {
    await assert.rejects(
      downloadVerified(releaseFor(base, PAYLOAD), { clock: immediateClock, timeoutMs: 1 }),
      /DOWNLOAD_FAILED.*timed out/,
    );
  });
});
