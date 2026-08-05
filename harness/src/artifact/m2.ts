/**
 * M2 supply-chain acceptance checks (L0.5 publish side) — the fake-server
 * and artifact-factory REALLY sign, and the real upgrader gate refuses
 * anything its roots did not bless. Each check throws on violation.
 *
 *  - a release signed by a key NO trusted root endorsed is refused
 *    (compromised publisher: consistent digest AND self-consistent chain,
 *    just not one the roots vouched for);
 *  - a tampered artifact with a re-consistent digest is refused by the
 *    SIGNATURE (integrity passes; authenticity must not);
 *  - an explicitly `unsigned: true` release installs but is recorded as
 *    unverified (never a silent default).
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { type ToothContext } from "../teeth/registry.ts";
import { parseManifest, currentPlatformKey } from "../../../core/src/artifact/staticManifestSource.ts";
import { MANIFEST_FILE } from "../fake-server/manifest.ts";
import { runCommand } from "../artifact-factory/run.ts";
import {
  buildSwapTool,
  swapToolEnv,
  readState,
  serveRelease,
} from "./m1.ts";
import type { FakeServer } from "../fake-server/server.ts";

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function versionOf(binPath: string): Promise<string> {
  const v = await runCommand(binPath, ["--version"], { timeoutMs: 30000 });
  assert.equal(v.code, 0, `version command failed (${v.stderr.trim()})`);
  return v.stdout.trim();
}

/**
 * Seed stable 1.0.0 under the seed server's trusted root.
 * Returns the env for follow-up upgrades (trusting exactly the given roots).
 */
async function seedStable(ctx: ToothContext, binPath: string, seed: Awaited<ReturnType<typeof serveRelease>>) {
  const seedEnv = swapToolEnv(ctx, seed.url, [seed]);
  const seedRun = await runCommand(binPath, ["self", "upgrade"], { env: seedEnv, timeoutMs: 30000 });
  assert.equal(seedRun.code, 0, `seed upgrade must exit 0 (${seedRun.stderr.trim()})`);
  const seeded = await readState(seedEnv);
  assert.equal(seeded.stableVersion, "1.0.0", "seed upgrade must land stable 1.0.0");
  return seedEnv;
}

// ---------------------------------------------------------------------------
// a signing key the roots never blessed must be refused
// ---------------------------------------------------------------------------

export async function checkM2UntrustedSignerRefused(
  ctx: ToothContext,
  opts: { trustAttacker?: boolean } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  const seed = await serveRelease(ctx, { version: "1.0.0", behavior: "ok", name: "seed" });
  // The attacker serves a SELF-CONSISTENT release (its own root signs its
  // signing key, the digest matches its bytes) — just under a root the
  // client does not trust. A real compromised publisher looks exactly like
  // this.
  const attacker = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "attacker" });
  try {
    await seedStable(ctx, binPath, seed);

    const trusted = opts.trustAttacker ? [seed, attacker] : [seed];
    const attackEnv = swapToolEnv(ctx, attacker.url, trusted);
    await runCommand(binPath, ["self", "upgrade"], { env: attackEnv, timeoutMs: 30000 });

    assert.equal(
      await versionOf(binPath),
      "1.0.0",
      "a release signed by an untrusted key must not land (trustAttacker mutation => RED)",
    );
    const state = await readState(attackEnv);
    assert.equal(state.stableVersion, "1.0.0", "stable must stay at the trusted version");
  } finally {
    await seed.stop();
    await attacker.stop();
  }
}

// ---------------------------------------------------------------------------
// tampered bytes with a re-consistent digest must be refused by the signature
// ---------------------------------------------------------------------------

export async function checkM2TamperedArtifactRefused(
  ctx: ToothContext,
  opts: { skipTamper?: boolean } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  const seed = await serveRelease(ctx, { version: "1.0.0", behavior: "ok", name: "seed" });
  const target = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "target" });
  try {
    await seedStable(ctx, binPath, seed);

    if (!opts.skipTamper) {
      // Attack: corrupt the artifact AND rewrite the served manifest with a
      // digest that matches the tampered bytes — the "compromised server
      // keeps its digests consistent" model. The sha256 gate passes; only
      // the signature over the ORIGINAL bytes can catch it.
      const manifestText = new TextDecoder().decode(await target.store.readFile(MANIFEST_FILE));
      const manifest = parseManifest(manifestText);
      const platform = currentPlatformKey();
      const targetInfo = manifest.targets[platform];
      assert.ok(targetInfo, "manifest must carry the current platform target");
      await target.corruptByte(targetInfo.file, 0);
      const tampered = await target.store.readFile(targetInfo.file);
      const tamperedSha = sha256Hex(tampered);
      manifest.targets[platform] = { ...targetInfo, sha256: tamperedSha };
      const servedManifest = path.join(
        ctx.sandboxDir,
        "serve-target",
        "releases",
        "2.0.0",
        MANIFEST_FILE,
      );
      await fs.writeFile(servedManifest, JSON.stringify(manifest, null, 2));
    }

    const targetEnv = swapToolEnv(ctx, target.url, [seed, target]);
    await runCommand(binPath, ["self", "upgrade"], { env: targetEnv, timeoutMs: 30000 });

    assert.equal(
      await versionOf(binPath),
      "1.0.0",
      "a tampered artifact must not land even with a consistent digest (skipTamper => RED)",
    );
    const state = await readState(targetEnv);
    assert.equal(state.stableVersion, "1.0.0", "stable must stay at the trusted version");
  } finally {
    await seed.stop();
    await target.stop();
  }
}

// ---------------------------------------------------------------------------
// explicit unsigned:true installs but is recorded as unverified
// ---------------------------------------------------------------------------

export async function checkM2UnsignedExplicitAccepted(
  ctx: ToothContext,
  opts: { serveSigned?: boolean } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  const seed = await serveRelease(ctx, { version: "1.0.0", behavior: "ok", name: "seed" });
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: "ok",
    name: "target",
    unsigned: !opts.serveSigned,
  });
  try {
    await seedStable(ctx, binPath, seed);

    // K_ACCEPT_UNSIGNED is the DEMO APP's own switch: accepting unattributable
    // bytes is a client decision. Without it this same release is refused --
    // which is what m2.unsigned-refused-by-default pins.
    const targetEnv = { ...swapToolEnv(ctx, target.url, [seed, target]), K_ACCEPT_UNSIGNED: "1" };
    const up = await runCommand(binPath, ["self", "upgrade"], { env: targetEnv, timeoutMs: 30000 });
    assert.equal(up.code, 0, `unsigned upgrade must exit 0 (${up.stderr.trim()})`);
    assert.match(
      up.stderr,
      /installed-unverified/,
      "an unsigned release must be reported as unverified (serveSigned mutation => RED)",
    );
    assert.equal(await versionOf(binPath), "2.0.0", "the unsigned release must install");
    const state = await readState(targetEnv);
    assert.equal(state.stableVersion, "2.0.0", "stable must hold the declared-unsigned version");
  } finally {
    await seed.stop();
    await target.stop();
  }
}

/**
 * The default posture. Same publisher, same bytes, same absent signature --
 * the only difference is that the client never said it would accept
 * unattributable bytes, so K refuses instead of installing.
 *
 * This is the tooth that makes the "unsigned" story non-vacuous: without it,
 * accepting unsigned bytes and accepting everything look identical.
 */
export async function checkM2UnsignedRefusedByDefault(
  ctx: ToothContext,
  opts: { clientAccepts?: boolean } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  // Servers are tracked from the moment they exist: if the SECOND publish
  // throws, an untracked first server keeps the event loop alive and this
  // failure would surface as a 2-minute hang instead of a red assertion.
  const servers: FakeServer[] = [];
  try {
    const seed = await serveRelease(ctx, { version: "1.0.0", behavior: "ok", name: "seed" });
    servers.push(seed);
    const target = await serveRelease(ctx, {
      version: "2.0.0",
      behavior: "ok",
      name: "target",
      unsigned: true,
    });
    servers.push(target);
    await seedStable(ctx, binPath, seed);
    const env = {
      ...swapToolEnv(ctx, target.url, [seed, target]),
      ...(opts.clientAccepts === true ? { K_ACCEPT_UNSIGNED: "1" } : {}),
    };
    await runCommand(binPath, ["self", "upgrade"], { env, timeoutMs: 30000 });
    assert.equal(
      await versionOf(binPath),
      "1.0.0",
      "an unsigned release must NOT install unless the client accepts it (clientAccepts mutation => RED)",
    );
    const state = await readState(env);
    assert.equal(state.stableVersion, "1.0.0", "stable must be untouched");
  } finally {
    for (const s of servers) await s.stop();
  }
}
