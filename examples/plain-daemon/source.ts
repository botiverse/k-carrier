/**
 * plain-daemon — the daemon-profile example (design-v1 §2.5: full L1
 * two-slot + L2 + L3 binary predicate).
 *
 * A real long-running service process (zero deps). It implements the
 * daemon's HostAdapter surface in process reality: start (ready line with
 * pid + per-incarnation startId), health probe over a tiny stdin/stdout
 * line protocol (evidence binds version+pid+startId to the live
 * incarnation — #5245 discipline), stop (exit). `self upgrade` swaps the
 * binary atomically and reports "restart to apply" — the next spawned
 * incarnation runs the new version. quiesce/resume are no-ops (daemon
 * profile has no hosted workloads).
 *
 * Built by the artifact-factory: `__K_VERSION__` / `__K_BEHAVIOR__`
 * stamped into the binary. `K_RELEASE_BASE` env = releaseBase config.
 */
export const PLAIN_DAEMON_SOURCE = `#!/usr/bin/env node
// plain-daemon — K daemon-profile example. Built by artifact-factory.
"use strict";
const VERSION = "__K_VERSION__";
const BEHAVIOR = "__K_BEHAVIOR__";
const RELEASE_BASE = process.env.K_RELEASE_BASE;
const fs = require("node:fs");
const args = process.argv.slice(2);
const startId = process.pid + "-" + process.hrtime.bigint().toString(36);
// Synchronous writes: process.exit()/SIGKILL can truncate buffered pipe
// writes; ready/evidence are the line-protocol contract, version is the
// black-box assertion surface.

if (args[0] === "--version") {
  fs.writeSync(1, VERSION + "\\n");
  process.exit(0);
}
if (args[0] === "self" && args[1] === "upgrade") {
  selfUpgrade().catch((e) => { process.stderr.write(String(e) + "\\n"); process.exit(5); });
} else {
  // daemon mode
  if (BEHAVIOR === "crash-on-start") { process.stderr.write("plain-daemon crashed\\n"); process.exit(1); }
  fs.writeSync(1, "ready " + JSON.stringify({ version: VERSION, pid: process.pid, startId }) + "\\n");
  process.stdin.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\\n")) {
      const cmd = line.trim();
      if (cmd === "probe") {
        const evidence = { version: BEHAVIOR === "wrong-version-probe" ? "9.9.9" : VERSION, pid: process.pid, startId };
        fs.writeSync(1, "evidence " + JSON.stringify(evidence) + "\\n");
      } else if (cmd === "exit") {
        process.exit(0);
      }
    }
  });
  setInterval(() => {}, 1 << 30);
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
  fs.renameSync(tmp, selfPath);
  fs.writeSync(1, "upgraded to " + manifest.version + " — restart to apply\\n");
  process.exit(0);
}
`;
