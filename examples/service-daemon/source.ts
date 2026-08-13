/**
 * service-daemon — the service-profile example (design-v1 §2.5: full L1
 * two-slot + L2 + L3; archer's M3 spec: process cardinality 1, liveness by
 * EVIDENCE not sleep).
 *
 * Two roles in one binary:
 *  - bare run = the SERVICE: on startup it first RECOVERS any pending
 *    transaction (a handover may have outlived the process that drove it —
 *    computer's shape), then registers its incarnation
 *    (version + pid + startId) in `<stateDir>/incarnation.json` and speaks
 *    a tiny stdin/stdout line protocol (`probe` -> evidence, `exit` ->
 *    stop). `crash-on-start` exits before everything.
 *  - `self upgrade` = the DRIVER: runs core's Upgrader with a REAL host.
 *    stop() SIGKILLs the registered incarnation and VERIFIES it is gone
 *    (signal-sent ≠ dead). start() means "the successor has been asked
 *    for" — on a self-starting host (K_HOST_SHAPE=spawn) it spawns the
 *    slot artifact as a detached child; on a non-self-starting host
 *    (K_HOST_SHAPE=respawn, computer's real shape) the driver EXITS and
 *    the owner respawns it from the new bytes. Only healthProbe() can say
 *    the successor is running.
 *
 * Dependency wiring (the example's "@k-carrier/core" stand-in):
 * `K_CORE_UPGRADER` = file URL of core/src/createUpgrader.ts; siblings are
 * derived from it. `K_RELEASE_BASE` = releaseBase, `K_STATE_DIR` =
 * stateDir (default `<binDir>/state`)
 * trust anchor (JSON array of PEMs), `K_HOST_SHAPE` = spawn|respawn.
 */
export const PLAIN_DAEMON_SOURCE = `#!/usr/bin/env node
// service-daemon — K service-profile example. Built by artifact-factory.
"use strict";
const VERSION = "__K_VERSION__";
const BEHAVIOR = "__K_BEHAVIOR__";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const RELEASE_BASE = process.env.K_RELEASE_BASE;
const STATE_DIR = process.env.K_STATE_DIR ?? path.join(path.dirname(process.argv[1]), "state");
const CORE_UPGRADER = process.env.K_CORE_UPGRADER;
const HOST_SHAPE = process.env.K_HOST_SHAPE ?? "spawn"; // spawn | respawn
const args = process.argv.slice(2);
const startId = process.pid + "-" + process.hrtime.bigint().toString(36);
const INCARNATION_FILE = path.join(STATE_DIR, "incarnation.json");

function wsync(s, m) { fs.writeSync(s, m + "\\n"); }
function readIncarnation() {
  try { return JSON.parse(fs.readFileSync(INCARNATION_FILE, "utf8")); } catch { return null; }
}
function writeIncarnation() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(INCARNATION_FILE, JSON.stringify({ version: VERSION, pid: process.pid, startId }));
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() > deadline) throw new Error("pid " + pid + " still alive after " + timeoutMs + "ms");
    await sleep(10);
  }
}
function readLine(child, prefix, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for \\"" + prefix + "\\" from service")); }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      // Only COMPLETE lines (newline-terminated) are protocol messages; a
      // partial chunk must never be mistaken for a full one (truncated JSON).
      for (;;) {
        const nl = buffer.indexOf("\\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith(prefix + " ")) {
          cleanup();
          resolve(line.slice(prefix.length + 1));
          return;
        }
      }
    };
    const cleanup = () => { clearTimeout(timer); child.stdout?.off("data", onData); };
    child.stdout?.on("data", onData);
  });
}
/** Wait for the ready line; null if the child died or never became ready. */
async function tryReady(child, timeoutMs) {
  try { return JSON.parse(await readLine(child, "ready", timeoutMs)); }
  catch { return null; }
}

(async () => {
  if (args[0] === "--version") {
    wsync(1, VERSION);
    process.exit(0);
  }
  if (args[0] === "self" && args[1] === "upgrade") {
    try {
      await selfUpgrade();
    } catch (e) {
      wsync(2, String(e));
      process.exit(5);
    }
    return;
  }
  // ---- SERVICE role ----
  if (BEHAVIOR === "crash-on-start") { wsync(2, "service-daemon crashed"); process.exit(1); }
  if (process.env.K_SKIP_RECOVERY !== "1") {
    await runRecovery(); // a handover may have outlived its driver
  }
  writeIncarnation();
  wsync(1, "ready " + JSON.stringify({ version: VERSION, pid: process.pid, startId }));
  process.stdin.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\\n")) {
      const cmd = line.trim();
      if (cmd === "probe") {
        wsync(1, "evidence " + JSON.stringify({ version: VERSION, pid: process.pid, startId }));
      } else if (cmd === "exit") {
        process.exit(0);
      }
    }
  });
  setInterval(() => {}, 1 << 30);
})();

/** The upgrader used by the SERVICE on startup: recovery ONLY, never an
 * upgrade attempt (a NULL source means nothing to do after recovery). */
async function runRecovery() {
  if (!CORE_UPGRADER) return; // no core wiring: nothing to recover
  const coreSrcUrl = new URL(".", CORE_UPGRADER).href;
  const { createUpgrader } = await import(CORE_UPGRADER);
  const nullSource = {
    checkForUpdate: async () => null,
    fetchRelease: async () => { throw new Error("the service role never fetches"); },
  };
  const recoveryHost = {
    async quiesce() {},
    async stop() {},
    async start(slot) {
      // Terminal rollback recovery is redo: start(stable) may run again in
      // the stable successor that the previous attempt already launched.
      // HostAdapter.start is idempotent, so that successor must stay alive
      // instead of requesting an endless chain of respawns.
      const slotVersionPath = path.join(STATE_DIR, "slots", slot, "VERSION");
      const slotVersion = fs.existsSync(slotVersionPath)
        ? fs.readFileSync(slotVersionPath, "utf8").trim()
        : null;
      if (slotVersion === VERSION) return;
      // a rollback pulls the old version back by asking for a successor; on
      // a non-self-starting host that means exiting for the owner to respawn
      if (HOST_SHAPE === "respawn") {
        wsync(2, "requested stable successor; exiting for respawn");
        process.exit(0);
      }
    },
    async healthProbe() {
      return { version: VERSION, pid: process.pid, startId };
    },
    async resume() {},
  };
  const upgrader = createUpgrader({
    host: recoveryHost,
    source: nullSource,
    policy: "auto",
    notificationSink: async () => {},
    stateDir: STATE_DIR,
  });
  try {
    await upgrader.upgrade(); // engine.recover() finishes/undoes any pending handover
  } catch (e) {
    if (String(e).includes("UPGRADE_IN_PROGRESS")) {
      // Another process is driving the upgrade right now (self-starting
      // driver is still alive): this is not the successor, just serve.
      return;
    }
    throw e;
  }
}

async function selfUpgrade() {
  if (!RELEASE_BASE) { wsync(2, "K_RELEASE_BASE not set"); process.exit(2); }
  if (!CORE_UPGRADER) { wsync(2, "K_CORE_UPGRADER not set"); process.exit(2); }
  const coreSrcUrl = new URL(".", CORE_UPGRADER).href;
  const { createUpgrader } = await import(CORE_UPGRADER);
  const { staticManifestSource } = await import(new URL("artifact/staticManifestSource.ts", coreSrcUrl).href);

  // The DRIVER's host. Before the handover, healthProbe reports the
  // registered incarnation (who is being replaced — the engine records its
  // startId as priorStartId). After start(), it reports the successor.
  let requested = false;
  let successor = null;
  const host = {
    async quiesce() {}, // service profile hosts no workloads
    async stop() {
      if (process.env.K_STUCK_DRIVER === "1") {
        // A wedged host: stop() never returns. The engine's host-call budget
        // must time this out; the successor's recovery then decides by
        // evidence, never by a flag.
        await new Promise(() => {});
      }
      const inc = readIncarnation();
      if (inc && inc.pid !== process.pid) {
        try { process.kill(inc.pid, "SIGKILL"); } catch { /* already gone */ }
        await waitDead(inc.pid, 5000);
      }
    },
    async start(slot) {
      requested = true;
      const artifact = path.join(STATE_DIR, "slots", slot, "artifact.bin");
      if (!fs.existsSync(artifact)) throw new Error("slot " + slot + " has no artifact");
      if (HOST_SHAPE === "respawn") {
        // computer's shape: we cannot start ourselves. Request the successor
        // by exiting; the owner respawns us from the new bytes. The journal
        // stays at handing-over; the successor's recovery finishes it.
        wsync(2, "requested successor; exiting for respawn");
        process.exit(0);
      }
      const child = spawn(process.execPath, [artifact], {
        env: { ...process.env, K_STATE_DIR: STATE_DIR },
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      });
      child.unref(); // the service outlives the driver
      const info = await tryReady(child, 5000);
      successor = info === null ? null : { child, ...info };
    },
    async healthProbe() {
      if (requested) {
        // the successor must answer; silence or a dead child is a failure
        if (successor === null || successor.child.exitCode !== null) {
          throw new Error("no live successor to probe");
        }
        successor.child.stdin.write("probe\\n");
        const line = await readLine(successor.child, "evidence", 5000);
        return JSON.parse(line);
      }
      const inc = readIncarnation();
      if (!inc) throw new Error("no registered service to probe");
      return inc; // the app's own record of the incarnation being replaced
    },
    async resume() {},
  };

  const upgrader = createUpgrader({
    host,
    source: staticManifestSource({ baseUrl: RELEASE_BASE }),
    policy: "auto",
    notificationSink: async (ev) => {
      const reason = ev.detail.reason !== undefined ? ": " + ev.detail.reason : "";
      wsync(2, "notify " + ev.kind + reason);
    },
    stateDir: STATE_DIR,
  });

  const outcome = await upgrader.upgrade();
  if (outcome.result === "promoted") {
    const st = await upgrader.state();
    wsync(1, "upgraded to " + st.stableVersion);
    process.exit(0);
  }
  if (outcome.result === "rolled-back") {
    wsync(1, "rolled back: " + outcome.reason);
    process.exit(1);
  }
  if (outcome.result === "held") {
    wsync(1, "held: " + outcome.reason);
    process.exit(0);
  }
  wsync(1, "up to date");
  process.exit(0);
}
`;
