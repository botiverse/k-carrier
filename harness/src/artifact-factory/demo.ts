/**
 * The artifact-factory's built-in demo source (harness-design §1.77).
 *
 * A tiny zero-dependency node script that IS the "demo binary". It
 * implements the black-box CLI contract (§1.76): `--version` prints the
 * stamped version, and `self upgrade` performs a cli-profile self-upgrade
 * (L1': fetch the manifest from K_RELEASE_BASE, verify the artifact's
 * sha256, atomically swap its own bytes — next run is the new version).
 * The default run reports its version (the factory teeth's "runs and
 * reports" claim).
 *
 * `__K_VERSION__` / `__K_BEHAVIOR__` are the stamp placeholders; behavior
 * bakes deliberate breakage into the artifact (fixture source for rollback
 * teeth, known-red and adversarial samples).
 *
 * K_RELEASE_BASE is the config surface for the fake-server URL — a real
 * app configures its own release source; the harness points it at localhost.
 */
export const DEMO_SOURCE = `#!/usr/bin/env node
// K demo binary — stamped by artifact-factory (harness-design §1.77).
// Black-box cli contract (§1.76): --version / self upgrade. K_RELEASE_BASE
// env = this demo app's own release-source config (localhost in harness).
"use strict";
const VERSION = "__K_VERSION__";
const BEHAVIOR = "__K_BEHAVIOR__";
const RELEASE_BASE = process.env.K_RELEASE_BASE;
const fs = require("node:fs");
// Synchronous writes: process.exit()/SIGKILL can truncate buffered pipe
// writes, and the black-box assertions read stdout as evidence.
function report(v) { fs.writeSync(1, v + " ready\\n"); }
function printVersion() { fs.writeSync(1, VERSION + "\\n"); process.exit(0); }

async function selfUpgrade() {
  if (!RELEASE_BASE) { process.stderr.write("K_RELEASE_BASE not set\\n"); process.exit(2); }
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const res = await fetch(RELEASE_BASE + "/manifest.json");
  if (!res.ok) { process.stderr.write("manifest fetch failed: " + res.status + "\\n"); process.exit(3); }
  const manifest = await res.json();
  const targetKeys = Object.keys(manifest.targets);
  const target = manifest.targets[targetKeys[0]];
  if (!target) { process.stderr.write("manifest has no targets\\n"); process.exit(3); }
  const art = await fetch(RELEASE_BASE + "/" + target.file);
  if (!art.ok) { process.stderr.write("artifact fetch failed: " + art.status + "\\n"); process.exit(3); }
  const bytes = Buffer.from(await art.arrayBuffer());
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (hash !== target.sha256) { process.stderr.write("sha256 mismatch\\n"); process.exit(4); }
  const selfPath = process.argv[1];
  const tmp = selfPath + ".tmp";
  fs.writeFileSync(tmp, bytes, { mode: 0o755 });
  fs.renameSync(tmp, selfPath); // cli-profile L1': swap bytes, next run is new version
  fs.writeSync(1, "upgraded to " + manifest.version + "\\n");
  process.exit(0);
}

const args = process.argv.slice(2);
if (args[0] === "self" && args[1] === "upgrade") {
  selfUpgrade().catch((e) => { process.stderr.write(String(e) + "\\n"); process.exit(5); });
} else if (args[0] === "--version") {
  printVersion();
} else {
  switch (BEHAVIOR) {
    case "crash-on-start": report(VERSION); process.exit(1); break;
    case "wrong-version-probe": report("9.9.9"); process.exit(0); break;
    case "hang-on-quiesce": report(VERSION); setInterval(() => {}, 2147483647); break;
    case "ok":
    default: report(VERSION); process.exit(0); break;
  }
}
`;
