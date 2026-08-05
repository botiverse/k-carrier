/**
 * M4 consent & notification acceptance checks (archer's M4 spec).
 *
 *  - confirm without approval: policy=confirm holds BEFORE any disk side
 *    effect — nothing is staged, not just nothing promoted.
 *  - consent binds a SPECIFIC version: the continuation after approval
 *    installs exactly the version that was offered; if the publisher moved
 *    on, the continuation refuses instead of installing whatever is
 *    current now. Consent is to a version, never to "the upgrade".
 *  - notify-only: the notification carries the version that is ACTUALLY
 *    installable, and nothing is staged.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { type ToothContext } from "../teeth/registry.ts";
import { FakeServer } from "../fake-server/server.ts";
import { runCommand } from "../artifact-factory/run.ts";
import { buildSwapTool, coreUpgraderUrl, readState, serveRelease } from "./m1.ts";
import { CLI_TOOL_SOURCE } from "../../../examples/swap-tool/source.ts";
import { ArtifactFactory } from "../artifact-factory/factory.ts";
import { currentPlatformKey } from "../../../core/src/artifact/staticManifestSource.ts";

function swapEnv(ctx: ToothContext, baseUrl: string, servers: FakeServer[], extra: Record<string, string> = {}): Record<string, string> {
  return {
    K_RELEASE_BASE: baseUrl,
    K_STATE_DIR: path.join(ctx.sandboxDir, "state"),
    K_CORE_UPGRADER: coreUpgraderUrl(),
    K_ROOT_KEYS: JSON.stringify(servers.map((s) => s.rootKeyPem)),
    ...extra,
  };
}

/** Assert the stateDir has NO transaction side effects at all (not staged). */
async function assertZeroDiskSideEffects(ctx: ToothContext): Promise<void> {
  const dir = path.join(ctx.sandboxDir, "state");
  let exists = true;
  try {
    await fs.access(dir);
  } catch {
    exists = false;
  }
  if (!exists) return;
  await assert.rejects(fs.access(path.join(dir, "journal.jsonl")), "journal must not exist");
  await assert.rejects(fs.access(path.join(dir, "slots")), "slots must not exist");
  await assert.rejects(fs.access(path.join(dir, "incoming")), "incoming must not exist");
}

// ---------------------------------------------------------------------------
// m4.confirm-no-consent-zero-side-effects
// ---------------------------------------------------------------------------

export async function checkM4ConfirmNoConsentZeroSideEffects(
  ctx: ToothContext,
  opts: { policy?: "confirm" | "auto" } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: "ok",
    name: "target",
    source: CLI_TOOL_SOURCE,
  });
  try {
    const env = swapEnv(ctx, target.url, [target], { K_POLICY: opts.policy ?? "confirm" });
    const up = await runCommand(binPath, ["self", "upgrade"], { env, timeoutMs: 30000 });
    assert.equal(
      up.code,
      0,
      `confirm-held must exit 0 (${up.stderr.trim()}; auto mutation => RED)`,
    );
    assert.match(up.stdout, /held: policy requires confirmation/, "confirm must hold, not install");
    assert.match(
      up.stderr,
      /notify confirm-request v2\.0\.0/,
      "a confirm-request must name the offered version",
    );
    // the whole point: nothing was staged, not just nothing promoted
    await assertZeroDiskSideEffects(ctx);
  } finally {
    await target.stop();
  }
}

// ---------------------------------------------------------------------------
// m4.consent-binds-version
// ---------------------------------------------------------------------------

export async function checkM4ConsentBindsVersion(
  ctx: ToothContext,
  opts: { serverSwitched?: boolean; expectInstalled?: boolean } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: "ok",
    name: "target",
    source: CLI_TOOL_SOURCE,
  });
  try {
    const env = swapEnv(ctx, target.url, [target], { K_POLICY: "confirm" });

    // 1) offer: confirm-request names 2.0.0
    const offer = await runCommand(binPath, ["self", "upgrade"], { env, timeoutMs: 30000 });
    assert.equal(offer.code, 0, `offer must hold (${offer.stderr.trim()})`);
    assert.match(offer.stdout, /held: policy requires confirmation/);
    assert.match(offer.stderr, /notify confirm-request v2\.0\.0/);

    // 2) the publisher moves on (or not) before the user answers
    if (opts.serverSwitched) {
      // the SAME server now serves 3.0.0 — the continuation must refuse the
      // approved 2.0.0, not silently install whatever is current
      // 3.0.0 must be a REAL, RUNNABLE release. Publishing garbage bytes here
      // made this tooth pass for the wrong reason: with version binding
      // removed, the continuation DID fetch 3.0.0 -- it just could not run, so
      // the probe failed and nothing was installed, which is exactly what the
      // oracle checks. The tooth then proves "the payload was unrunnable", not
      // "consent is bound to a version". (Found in review by removing the
      // binding and watching this stay green.)
      const switchedFactory = new ArtifactFactory({
        cacheDir: path.join(ctx.sandboxDir, "cache-switched"),
        demoSource: CLI_TOOL_SOURCE,
      });
      await switchedFactory.makeRelease({
        version: "3.0.0",
        behavior: "ok",
        store: target.store,
        platform: currentPlatformKey(),
      });
      try {
        const continueRun = await runCommand(binPath, ["confirm", "upgrade", "2.0.0"], {
          env,
          timeoutMs: 30000,
        });
        const v = await versionOf(binPath);
        const st = await readState(env);
        const nothingInstalled = v === "1.0.0" && st.stableVersion === "0.0.0";
        if (opts.expectInstalled === true) {
          // mutation expectation: the binding was lost and the continuation
          // installed something — the zero-install assertion must go RED
          assert.ok(!nothingInstalled, "the binding must have installed the offered version (expectInstalled => RED)");
        } else {
          assert.ok(nothingInstalled, "the continuation must refuse when the approved version is no longer served");
          assert.match(continueRun.stdout, /held/, "the refusal must be a typed held, not a silent install");
          assert.match(continueRun.stdout, /no longer served|nothing was installed/);
        }
        return;
      } finally {
        // nothing extra to stop: the switched release lives on `target`
      }
    }

    // 3) green: the continuation installs EXACTLY the offered version
    const cont = await runCommand(binPath, ["confirm", "upgrade", "2.0.0"], {
      env,
      timeoutMs: 30000,
    });
    assert.equal(cont.code, 0, `continuation must exit 0 (${cont.stderr.trim()})`);
    assert.match(cont.stdout, /upgraded to 2\.0\.0/);
    assert.equal(await versionOf(binPath), "2.0.0", "the continuation must install the OFFERED version");
    const st = await readState(env);
    assert.equal(st.stableVersion, "2.0.0", "stable must hold the approved version");
    assert.equal(st.phase, "promoted");
  } finally {
    await target.stop();
  }
}

async function versionOf(binPath: string): Promise<string> {
  const v = await runCommand(binPath, ["--version"], { timeoutMs: 30000 });
  assert.equal(v.code, 0, `version command failed (${v.stderr.trim()})`);
  return v.stdout.trim();
}

// ---------------------------------------------------------------------------
// m4.notify-only-reports-installable-version
// ---------------------------------------------------------------------------

export async function checkM4NotifyOnlyReportsInstallableVersion(
  ctx: ToothContext,
  opts: { policy?: "notify-only" | "confirm" } = {},
): Promise<void> {
  const binPath = await buildSwapTool(ctx);
  const target = await serveRelease(ctx, {
    version: "2.0.0",
    behavior: "ok",
    name: "target",
    source: CLI_TOOL_SOURCE,
  });
  try {
    const env = swapEnv(ctx, target.url, [target], { K_POLICY: opts.policy ?? "notify-only" });
    const up = await runCommand(binPath, ["self", "upgrade"], { env, timeoutMs: 30000 });
    assert.equal(up.code, 0, `notify-only must exit 0 (${up.stderr.trim()}; confirm mutation => RED)`);
    assert.match(up.stdout, /held: policy is notify-only/, "notify-only must hold, not install");
    // the notification must name the version that is ACTUALLY installable
    assert.match(up.stderr, /notify held v2\.0\.0: notify-only/);
    await assertZeroDiskSideEffects(ctx);
  } finally {
    await target.stop();
  }
}

