/**
 * swap-tool — the swap-profile example (design-v1 §2.5: L0 + L0.5 + L1').
 *
 * A REAL tiny CLI (zero deps) with one genuine command (`greet`) plus the
 * black-box contract (§1.76): `--version` and `self upgrade` (declared
 * explicitly in `k.target.ts` — the harness never guesses commands).
 *
 * `self upgrade` runs through core's Upgrader (createUpgrader +
 * staticManifestSource + atomicWriteFile): gates in order (ownership ->
 * policy -> verified download -> transaction), then the app's install step
 * (swap the promoted slot's bytes over itself — L1': swap bytes = promote,
 * next run takes effect). In the swap profile the app IS the process, so
 * the host's probe verifies the experiment's bytes headlessly
 * (`--probe`) — a new version that fails to start rolls the transaction
 * back instead of being promoted.
 *
 * Dependency wiring (the example's "@k-carrier/core" stand-in):
 * `K_CORE_UPGRADER` = file URL of core/src/createUpgrader.ts; sibling core
 * modules are derived from it. `K_RELEASE_BASE` = releaseBase config,
 * `K_STATE_DIR` = stateDir (default: `<binDir>/state`).
 *
 * Built by the artifact-factory: `__K_VERSION__` / `__K_BEHAVIOR__` are
 * stamped into the binary's own bytes.
 */
export const CLI_TOOL_SOURCE = `#!/usr/bin/env node
// swap-tool — K swap-profile example. Built by artifact-factory (§1.77).
// self upgrade runs through core's Upgrader; --probe is the headless
// start check the swap-profile host uses to verify new bytes.
"use strict";
const VERSION = "__K_VERSION__";
const BEHAVIOR = "__K_BEHAVIOR__";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const RELEASE_BASE = process.env.K_RELEASE_BASE;
const STATE_DIR = process.env.K_STATE_DIR ?? path.join(path.dirname(process.argv[1]), "state");
const CORE_UPGRADER = process.env.K_CORE_UPGRADER;
// Trust anchor: the app compiles root public keys in; the demo (not
// packaged) gets them via K_ROOT_KEYS (JSON array of PEMs).
const ROOT_KEYS = process.env.K_ROOT_KEYS ? JSON.parse(process.env.K_ROOT_KEYS) : [];
const args = process.argv.slice(2);
const startId = process.pid + "-" + process.hrtime.bigint().toString(36);
// Synchronous writes: process.exit() can truncate buffered pipe writes,
// and the black-box assertions read stdout as evidence.

if (args[0] === "--probe") {
  // headless start check used by the swap-profile host during an upgrade
  fs.writeSync(1, VERSION + "\\n");
  process.exit(BEHAVIOR === "crash-on-start" ? 1 : 0);
}
if (args[0] === "greet") {
  fs.writeSync(1, "Hello, " + (args[1] ?? "world") + "! (v" + VERSION + ")\\n");
  process.exit(0);
}
if (args[0] === "--version") {
  fs.writeSync(1, VERSION + "\\n");
  process.exit(0);
}
if (args[0] === "self" && args[1] === "upgrade") {
  selfUpgrade().catch((e) => { fs.writeSync(2, String(e) + "\\n"); process.exit(5); });
} else {
  switch (BEHAVIOR) {
    case "crash-on-start": fs.writeSync(2, "swap-tool crashed\\n"); process.exit(1); break;
    case "hang-on-quiesce": fs.writeSync(1, "swap-tool " + VERSION + "\\n"); setInterval(() => {}, 2147483647); break;
    case "ok":
    default: fs.writeSync(1, "swap-tool " + VERSION + "\\n"); process.exit(0); break;
  }
}

async function selfUpgrade() {
  if (!RELEASE_BASE) { fs.writeSync(2, "K_RELEASE_BASE not set\\n"); process.exit(2); }
  if (!CORE_UPGRADER) { fs.writeSync(2, "K_CORE_UPGRADER not set (the example's @k-carrier/core wiring)\\n"); process.exit(2); }
  const coreSrcUrl = new URL(".", CORE_UPGRADER).href;
  const { createUpgrader } = await import(CORE_UPGRADER);
  const { staticManifestSource } = await import(new URL("artifact/staticManifestSource.ts", coreSrcUrl).href);
  const { atomicWriteFile } = await import(new URL("artifact/swap.ts", coreSrcUrl).href);
  const { slotArtifactPath } = await import(new URL("txn/fileEffects.ts", coreSrcUrl).href);

  // swap profile: the app IS the process. The probe verifies the
  // experiment's bytes actually start (headless --probe run); a new
  // version that fails to start makes the transaction roll back.
  const host = {
    async quiesce() {},
    async stop() {},
    async start() {},
    async healthProbe() {
      const experiment = path.join(STATE_DIR, "slots", "experiment", "artifact.bin");
      if (fs.existsSync(experiment)) {
        const r = spawnSync(process.execPath, [experiment, "--probe"], { encoding: "utf8", timeout: 5000 });
        if (r.status !== 0) {
          throw new Error("experiment artifact failed to start (status " + r.status + ")");
        }
        return { version: r.stdout.trim(), pid: process.pid, startId };
      }
      return { version: VERSION, pid: process.pid, startId };
    },
    async resume() {},
  };

  // Accepting bytes nobody vouched for is a CLIENT decision, so it is made
  // here in the adopter's code -- never by an option on the source and never
  // by a field in the manifest (the manifest is served by the very party the
  // signature chain exists to distrust; see core/src/artifact/sourceTrust.test.ts).
  // Real products sign; this switch exists so the harness can exercise the
  // "no signing story yet" posture deliberately.
  const published = staticManifestSource({ baseUrl: RELEASE_BASE });
  const source = process.env.K_ACCEPT_UNSIGNED === "1"
    ? {
        checkForUpdate: async (ctx) => {
          const r = await published.checkForUpdate(ctx);
          return r === null ? null : { ...r, unsigned: true };
        },
        fetchRelease: async (v, ctx) => ({ ...(await published.fetchRelease(v, ctx)), unsigned: true }),
      }
    : published;

  const upgrader = createUpgrader({
    host,
    source,
    policy: "auto",
    notificationSink: async (ev) => {
      const reason = ev.detail.reason !== undefined ? ": " + ev.detail.reason : "";
      fs.writeSync(2, "notify " + ev.kind + reason + "\\n");
    },
    rootKeys: ROOT_KEYS,
    stateDir: STATE_DIR,
  });

  const outcome = await upgrader.upgrade();
  if (outcome.result === "promoted") {
    // install step: swap the promoted slot's bytes over ourselves
    const promoted = fs.readFileSync(slotArtifactPath(STATE_DIR, "stable"));
    await atomicWriteFile(process.argv[1], promoted);
    const st = await upgrader.state();
    fs.writeSync(1, "upgraded to " + st.stableVersion + "\\n");
    process.exit(0);
  }
  if (outcome.result === "rolled-back") {
    fs.writeSync(1, "rolled back: " + outcome.reason + "\\n");
    process.exit(1);
  }
  if (outcome.result === "held") {
    fs.writeSync(1, "held: " + outcome.reason + "\\n");
    process.exit(0);
  }
  fs.writeSync(1, "up to date\\n");
  process.exit(0);
}
`;
