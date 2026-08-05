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

export interface Sandbox {
  /** Unique temp dir (mkdtemp); the scenario's entire world. */
  readonly dir: string;
  /** Port reserved for this sandbox's fake-server. */
  readonly port: number;
  /** Sandbox marker file content (future pgrep-by-marker key). */
  readonly id: string;
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
  const dir = await fs.mkdtemp(path.join(baseDir, `k-harness-${prefix}-`));
  const id = path.basename(dir);
  const port = await allocatePort();
  // Marker file: future fake-host daemon teardown pgrep's by this id to
  // verify zero residual processes (harness-design §1.77).
  await fs.writeFile(path.join(dir, ".k-sandbox-marker"), `${id}\n`);

  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    await verifyProcessTreeDead(dir, id); // stub until fake-host daemon lands
    await fs.rm(dir, { recursive: true, force: true });
    reservedPorts.delete(port);
  };

  return { dir, port, id, teardown };
}

/**
 * Process-tree verify-dead — the teardown half that proves "发了 kill"≠
 * "死了" (zombie `__service` was a real production lesson). Currently a
 * no-op skeleton: it needs the fake-host daemon's spawn/pgrep conventions
 * (sandbox marker -> process group) before it can assert anything.
 *
 * Lands with harness/src/fake-host/ (archer: "进程树 verify-dead 那半等
 * fake-host daemon 到位再接") — at that point this pgrep's by marker id,
 * asserts zero matches, and fails teardown with a typed error otherwise.
 */
async function verifyProcessTreeDead(_sandboxDir: string, _markerId: string): Promise<void> {
  // Skeleton: fake-host daemon fills in the marker-pgrep here.
}
