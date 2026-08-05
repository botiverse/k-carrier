// @invariant — retiring the OS's own supervisor is the least reversible thing
// K does. It must be unlocked by EVIDENCE that the new lifecycle works, and an
// app that declared no surface has produced no such evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUpgrader } from "../createUpgrader.ts";
import { staticManifestSource } from "../artifact/staticManifestSource.ts";
import type { ProcessEvidence } from "../lifecycle/hostAdapter.ts";

const BYTES = new TextEncoder().encode("#!/bin/sh\necho 2.0.0\n");
const PLATFORM = `${process.platform}-${process.arch}`;

async function serve(): Promise<{ baseUrl: string; close: () => void }> {
  const sha = createHash("sha256").update(BYTES).digest("hex");
  const manifest = JSON.stringify({
    version: "2.0.0",
    targets: { [PLATFORM]: { file: "app.bin", sha256: sha, size: BYTES.length } },
  });
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("manifest.json")) { res.writeHead(200); res.end(manifest); return; }
    if (req.url?.endsWith(".k-sig.json")) { res.writeHead(404); res.end("unsigned"); return; }
    res.writeHead(200); res.end(Buffer.from(BYTES));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/app`, close: () => server.close() };
}

test("THE POINT: declaring no lifecycle surface must not unlock retirement", async () => {
  const src = await serve();
  const stateDir = await mkdtemp(path.join(tmpdir(), "k-retire-"));
  try {
    const published = staticManifestSource({ baseUrl: src.baseUrl });
    const upgrader = createUpgrader({
      host: {
        async quiesce() {}, async stop() {}, async start() {}, async resume() {},
        async healthProbe(): Promise<ProcessEvidence> {
          return { version: "2.0.0", pid: process.pid, startId: "fresh" };
        },
      },
      // no lifecycleSurfaces: this app never declared an OS read-back surface
      source: {
        checkForUpdate: async (ctx) => {
          const r = await published.checkForUpdate(ctx);
          return r === null ? null : { ...r, unsigned: true };
        },
        fetchRelease: async (v, ctx) => ({ ...(await published.fetchRelease(v, ctx)), unsigned: true }),
      },
      policy: "auto",
      notificationSink: async () => {},
      rootKeys: [],
      stateDir,
    });

    const outcome = await upgrader.upgrade();
    assert.equal(outcome.result, "promoted", "the upgrade itself is fine without surfaces");

    // The upgrade succeeded, but NOTHING observed the OS lifecycle. Retiring
    // the legacy manager here would leave the machine with no supervisor and
    // no evidence that anything would bring the service back.
    const retire = await upgrader.retireLegacyManager();
    assert.notEqual(retire, "retired", "retirement must not be unlocked by an unexamined property");
    assert.match((retire as { held: string }).held, /converged|declared/);
  } finally {
    src.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
