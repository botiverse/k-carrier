/**
 * The artifact-factory's built-in demo source (harness-design §1.77).
 *
 * A tiny zero-dependency node script that IS the "demo binary": it reports
 * its stamped version on start. The factory builds it once and stamps many
 * (post-build version-string injection — the same SHAPE as SEA-embedded
 * versions, fast and real; the version lives inside the artifact's own
 * bytes, never in a sidecar file).
 *
 * `__K_VERSION__` / `__K_BEHAVIOR__` are the stamp placeholders; behavior
 * bakes deliberate breakage into the artifact (fixture source for rollback
 * teeth, known-red and adversarial samples).
 */
export const DEMO_SOURCE = `#!/usr/bin/env node
// K demo binary — stamped by artifact-factory (harness-design §1.77).
"use strict";
const VERSION = "__K_VERSION__";
const BEHAVIOR = "__K_BEHAVIOR__";
function report(v) { process.stdout.write(v + " ready\\n"); }
switch (BEHAVIOR) {
  case "crash-on-start": report(VERSION); process.exit(1); break;
  case "wrong-version-probe": report("9.9.9"); process.exit(0); break;
  case "hang-on-quiesce": report(VERSION); setInterval(() => {}, 2147483647); break;
  case "ok":
  default: report(VERSION); process.exit(0); break;
}
`;
