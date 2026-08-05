/**
 * scenario sandbox (harness-design §1.3) — one scenario, one sandbox.
 *
 * Each sandbox owns:
 *  - a fresh temp stateDir (mkdtemp) — install dir, stateDir, and the
 *    fake-server's release store all live INSIDE it, so teardown =
 *    delete the sandbox (harness-design §1.77 "沙箱边界即清场边界");
 *  - an independently allocated localhost port, unique among live
 *    sandboxes, so parallel scenarios never collide;
 *  - a marker file carrying the sandbox id, so the future fake-host
 *    daemon's teardown half can pgrep by marker ("按沙箱标记 pgrep 复核
 *    零残留" — verify-dead; that half lands with the daemon, this is the
 *    skeleton it plugs into).
 *
 * teardown() currently deletes the sandbox tree; the process-tree
 * verify-dead step is a documented no-op stub until fake-host daemon
 * exists (archer: "进程树 verify-dead 那半等 fake-host daemon 到位再接").
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { processAlive } from "../fake-host/daemon.ts";
import { type ToothContext } from "../teeth/registry.ts";

/**
 * The sandbox marker env var: processes spawned inside a sandbox carry
 * `K_SANDBOX_MARKER=<sandbox id>`, making them discoverable out-of-band
 * via `ps e` so teardown can prove zero residuals (harness-design §1.77:
 * "按沙箱标记 pgrep 复核零残留").
 */
export const MARKER_ENV = "K_SANDBOX_MARKER";

export interface Sandbox {
  /** Unique temp dir (mkdtemp); the scenario's entire world. */
  readonly dir: string;
  /** Port reserved for this sandbox's fake-server. */
  readonly port: number;
  /** Sandbox marker file content (the pgrep-by-marker key). */
  readonly id: string;
  /** The env var a spawned process needs to be claimable by this sandbox. */
  envMarker(): Record<string, string>;
  /** Delete the sandbox tree; idempotent. */
  teardown(): Promise<void>;
}

export interface SandboxOptions {
  /** Prefix for the mkdtemp dir name. Default: "scenario". */
  prefix?: string;
  /** Parent dir for the sandbox. Default: os.tmpdir(). */
  baseDir?: string;
}

/** Ports currently reserved by live sandboxes (distinctness guarantee). */
const reservedPorts = new Set<number>();

/**
 * Allocate a free localhost port, unique among live sandboxes.
 * Binds 127.0.0.1:0, reads the OS-assigned port, closes, reserves it.
 * (The probe-close-bind window is the standard tradeoff; the reservation
 * set removes the practical parallel-collision case.)
 */
export async function allocatePort(): Promise<number> {
  for (;;) {
    const port = await probeFreePort();
    if (reservedPorts.has(port)) continue; // recently handed out; avoid reuse
    reservedPorts.add(port);
    return port;
  }
}

function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("allocatePort: no port assigned"));
      });
    });
  });
}

export async function createSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const baseDir = opts.baseDir ?? os.tmpdir();
  const prefix = opts.prefix ?? "scenario";
  const dir = await fs.mkdtemp(path.join(baseDir, `${SANDBOX_DIR_PREFIX}${prefix}-`));
  const id = path.basename(dir);
  const port = await allocatePort();
  // Marker file: future fake-host daemon teardown pgrep's by this id to
  // verify zero residual processes (harness-design §1.77).
  await fs.writeFile(path.join(dir, ".k-sandbox-marker"), `${id}\n`);

  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    await verifyProcessTreeDead(dir, id); // throws on residuals; dir kept as evidence
    await fs.rm(dir, { recursive: true, force: true });
    reservedPorts.delete(port);
    tornDown = true;
  };

  return { dir, port, id, envMarker: () => ({ [MARKER_ENV]: id }), teardown };
}

/**
 * All pids whose environment carries `NAME=value` (the sandbox-marker
 * scan). Reads `ps eaxo pid=,command=` — the `e` flag appends each
 * process's environment, so the marker is observable even for processes
 * whose parent has died (orphans/zombies the host no longer tracks).
 */
/** Prefix every sandbox directory name carries (see createSandbox). */
const SANDBOX_DIR_PREFIX = "k-harness-";

/**
 * The marker a process must carry to be found by this sandbox's teardown.
 *
 * Teeth often derive a NESTED context (e.g. `<sandbox>/respawn` per host
 * shape). Taking basename() of that nested dir yields "respawn", which no
 * teardown scan will ever match -- so the scan returns zero, the tooth reports
 * a clean teardown, and the leaked process is still running. The zero means
 * "the query matched nothing", not "nothing leaked". (Found 08-05 by looking
 * for the surviving pid instead of trusting the count.)
 *
 * So the marker is always resolved back to the SANDBOX's own id, however deep
 * the caller's context is nested.
 */
export function sandboxMarkerFor(dir: string): string {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    const base = path.basename(cur);
    if (base.startsWith(SANDBOX_DIR_PREFIX)) return base;
    if (path.dirname(cur) === cur) return path.basename(path.resolve(dir));
  }
}

export function findPidsByEnv(name: string, value: string): number[] {
  const out = execFileSync("ps", ["eaxo", "pid=,command="], { encoding: "utf8" });
  const token = `${name}=${value}`;
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    if (!line.includes(token)) continue;
    const m = /^\s*(\d+)/.exec(line);
    const pid = m?.[1];
    if (pid) pids.push(Number(pid));
  }
  return pids;
}

/** Typed teardown failure: residual processes survived the kill+verify. */
export class VerifyDeadError extends Error {
  readonly code = "SANDBOX_VERIFY_DEAD";
  readonly survivors: number[];

  constructor(survivors: number[]) {
    super(`SANDBOX_VERIFY_DEAD: ${survivors.length} process(es) still alive after teardown kill: ${survivors.join(", ")}`);
    this.name = "VerifyDeadError";
    this.survivors = survivors;
  }
}

const KILL_GRACE_MS = 2000;
const POLL_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

/**
 * Process-tree verify-dead — the teardown half that proves "发了 kill"≠
 * "死了" (zombie `__service` was a real production lesson): scan for every
 * process carrying this sandbox's marker, SIGKILL them, then make the OS
 * confirm each is gone. Any survivor raises a typed VerifyDeadError and
 * the sandbox dir is kept as evidence (the teardown did NOT succeed).
 */
export async function verifyProcessTreeDead(_sandboxDir: string, markerId: string): Promise<void> {
  const alive = findPidsByEnv(MARKER_ENV, markerId);
  if (alive.length === 0) return;
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone between the scan and the signal
    }
  }
  const survivors: number[] = [];
  const deadline = Date.now() + KILL_GRACE_MS;
  for (const pid of alive) {
    while (processAlive(pid)) {
      if (Date.now() > deadline) {
        survivors.push(pid);
        break;
      }
      await sleep(POLL_MS);
    }
  }
  if (survivors.length > 0) throw new VerifyDeadError(survivors);
}

/**
 * The sandbox verify-dead tooth check (registered as
 * scenario.sandbox-verify-dead): a process carrying the sandbox marker
 * must be SIGKILLed and OS-confirmed gone by teardown ("发了 kill"≠"死
 * 了"). `skipTeardownKill` simulates the must-red mutation (teardown's
 * kill/verify is a no-op) for known-red driving.
 */
export async function checkSandboxVerifyDead(
  ctx: ToothContext,
  opts: { skipTeardownKill?: boolean } = {},
): Promise<void> {
  const sb = await createSandbox({ prefix: "verify-dead", baseDir: ctx.sandboxDir });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, ...sb.envMarker() },
    stdio: "ignore", // no pipes: a failed assertion must not degrade into a hang
  });
  try {
    await waitForMarker(sb.id);
    if (opts.skipTeardownKill) {
      // mutation: teardown's kill/verify never ran — the marker process is
      // still alive, and the zero-residual assertion must go RED
      assert.deepEqual(
        findPidsByEnv(MARKER_ENV, sb.id),
        [],
        "after teardown no marker processes may remain (kill step skipped => RED)",
      );
      return;
    }
    await sb.teardown();
    assert.ok(!processAlive(child.pid ?? -1), "teardown must kill the marker process");
    assert.deepEqual(
      findPidsByEnv(MARKER_ENV, sb.id),
      [],
      "no marker processes may remain after teardown",
    );
    await assert.rejects(fs.access(sb.dir), "teardown must remove the sandbox dir");
  } finally {
    if (processAlive(child.pid ?? -1)) child.kill("SIGKILL");
    await sb.teardown().catch(() => {});
  }
}

async function waitForMarker(markerId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (findPidsByEnv(MARKER_ENV, markerId).length === 0) {
    if (Date.now() > deadline) throw new Error(`marker process ${markerId} never became visible`);
    await sleep(20);
  }
}
