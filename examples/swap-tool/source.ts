/**
 * swap-tool — the cli-profile example (design-v1 §2.5: L0 + L0.5 + L1').
 *
 * A REAL tiny CLI (zero deps) with one genuine command (`greet`) plus the
 * black-box contract (§1.76): `--version` and `self upgrade` (declared
 * explicitly in `k.target.ts` — the harness never guesses commands). The
 * cli profile's upgrade model is "swap bytes = promote, next run takes
 * effect" (L1'): self-upgrade fetches the manifest, verifies the
 * artifact's sha256, atomically swaps its own file. The signature chain is
 * served but verification of the two-level chain lands with core's
 * distsign (L0.5); today the demo pins the L0 integrity + swap semantics.
 *
 * Built by the artifact-factory: `__K_VERSION__` / `__K_BEHAVIOR__` are
 * stamped into the binary's own bytes (same SHAPE as SEA-embedded
 * versions). `K_RELEASE_BASE` env = releaseBase config.
 */
export const CLI_TOOL_SOURCE = `#!/usr/bin/env node
// swap-tool — K cli-profile example. Built by artifact-factory (§1.77).
"use strict";
const VERSION = "__K_VERSION__";
const BEHAVIOR = "__K_BEHAVIOR__";
const RELEASE_BASE = process.env.K_RELEASE_BASE;
const fs = require("node:fs");
const args = process.argv.slice(2);
// Synchronous writes: process.exit() can truncate buffered pipe writes,
// and the black-box assertions read stdout as evidence.

if (args[0] === "greet") {
  fs.writeSync(1, "Hello, " + (args[1] ?? "world") + "! (v" + VERSION + ")\\n");
  process.exit(0);
}
if (args[0] === "--version") {
  fs.writeSync(1, VERSION + "\\n");
  process.exit(0);
}
if (args[0] === "self" && args[1] === "upgrade") {
  selfUpgrade().catch((e) => { process.stderr.write(String(e) + "\\n"); process.exit(5); });
} else {
  switch (BEHAVIOR) {
    case "crash-on-start": process.stderr.write("swap-tool crashed\\n"); process.exit(1); break;
    case "hang-on-quiesce": fs.writeSync(1, "swap-tool " + VERSION + "\\n"); setInterval(() => {}, 2147483647); break;
    case "ok":
    default: fs.writeSync(1, "swap-tool " + VERSION + "\\n"); process.exit(0); break;
  }
}

async function selfUpgrade() {
  if (!RELEASE_BASE) { process.stderr.write("K_RELEASE_BASE not set\\n"); process.exit(2); }
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const res = await fetch(RELEASE_BASE + "/manifest.json");
  if (!res.ok) { process.stderr.write("manifest fetch failed: " + res.status + "\\n"); process.exit(3); }
  const manifest = await res.json();
  const target = manifest.targets[Object.keys(manifest.targets)[0]];
  if (!target) { process.stderr.write("manifest has no targets\\n"); process.exit(3); }
  const art = await fetch(RELEASE_BASE + "/" + target.file);
  if (!art.ok) { process.stderr.write("artifact fetch failed: " + art.status + "\\n"); process.exit(3); }
  const bytes = Buffer.from(await art.arrayBuffer());
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (hash !== target.sha256) { process.stderr.write("sha256 mismatch\\n"); process.exit(4); }
  const selfPath = process.argv[1];
  const tmp = selfPath + ".tmp";
  fs.writeFileSync(tmp, bytes, { mode: 0o755 });
  fs.renameSync(tmp, selfPath); // L1': swap bytes, next run is the new version
  fs.writeSync(1, "upgraded to " + manifest.version + "\\n");
  process.exit(0);
}
`;
