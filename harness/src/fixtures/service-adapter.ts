/**
 * Service-tier adopter adapter fixture — a STANDALONE implementation of
 * the five HostAdapter responsibilities with REAL process semantics, used
 * to exercise `k-harness --adapter` against the service-profile teeth
 * (upgrade / rollback / lifecycle-converged).
 *
 * It is intentionally NOT the demo's host: a real adopter brings its own
 * host semantics. This one models the computer-shaped host:
 *  - quiesce()/resume(): no-op (computer does not preserve sessions);
 *  - stop(): SIGKILL the running successor child and VERIFY it is gone
 *    (signal-sent ≠ dead);
 *  - start(): spawn the slot artifact as a real child process and wait
 *    for its ready line — the EVIDENCE. Only healthProbe() can say the
 *    successor is running;
 *  - healthProbe(): ask the LIVE process (the child's own ready/evidence
 *    line protocol) — never reads files, never computes its own version;
 *  - lifecycle surface: start() registers the OS auto-start entry
 *    (the app's SSOT) which the ReadbackSurface reads back.
 *
 * Default export contract: `(stateDir: string) => HostDriver`; the
 * lifecycle surfaces come from the same factory's `lifecycleSurfaces`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { HostAdapter, ProcessEvidence, Slot } from "../../../core/src/lifecycle/hostAdapter.ts";
import type { ReadbackSurface } from "../../../core/src/converge/predicates.ts";
import type { HostDriver, LedgerState } from "../fake-host/inproc.ts";
import { slotArtifactPath } from "../../../core/src/txn/fileEffects.ts";

interface Successor {
  child: ChildProcess;
  version: string;
  pid: number;
  startId: string;
}

function readLine(child: ChildProcess, prefix: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for "${prefix}" from successor`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      // Only COMPLETE lines (newline-terminated) are protocol messages.
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith(`${prefix} `)) {
          cleanup();
          resolve(line.slice(prefix.length + 1));
          return;
        }
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
    };
    child.stdout?.on("data", onData);
  });
}

async function tryReady(child: ChildProcess, timeoutMs: number): Promise<Successor | null> {
  try {
    const line = await readLine(child, "ready", timeoutMs);
    const info = JSON.parse(line) as { version: string; pid: number; startId: string };
    return { child, ...info };
  } catch {
    return null;
  }
}

export function createServiceAdapter(stateDir: string): HostDriver & {
  lifecycleSurfaces(): ReadbackSurface[];
} {
  let successor: Successor | null = null;
  let runningSlot: Slot | null = null;

  const autostartPath = path.join(stateDir, "lifecycle", "autostart.json");
  const writeAutostart = async (slot: Slot): Promise<void> => {
    await fs.mkdir(path.dirname(autostartPath), { recursive: true });
    await fs.writeFile(
      autostartPath,
      JSON.stringify({ enabled: true, target: slotArtifactPath(stateDir, slot) }),
    );
  };

  const host: HostAdapter = {
    async quiesce() {
      // computer does not preserve sessions: nothing to park
    },
    async stop() {
      runningSlot = null;
      const cur = successor;
      successor = null;
      if (cur) {
        try {
          process.kill(cur.pid, "SIGKILL");
        } catch {
          // already gone
        }
        const deadline = Date.now() + 5000;
        while (processAlive(cur.pid)) {
          if (Date.now() > deadline) throw new Error(`pid ${cur.pid} still alive`);
          await new Promise((r) => {
            setTimeout(r, 10);
          });
        }
      }
    },
    async start(slot: Slot) {
      runningSlot = slot;
      const artifact = slotArtifactPath(stateDir, slot);
      const child = spawn(process.execPath, [artifact], {
        env: { ...process.env, K_STATE_DIR: stateDir },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const info = await tryReady(child, 5000);
      successor = info;
      if (info !== null) await writeAutostart(slot);
    },
    async healthProbe(): Promise<ProcessEvidence> {
      const cur = successor;
      if (!cur || cur.child.exitCode !== null) throw new Error("no live successor to probe");
      cur.child.stdin?.write("probe\n");
      const line = await readLine(cur.child, "evidence", 5000);
      return JSON.parse(line) as ProcessEvidence;
    },
    async resume() {
      // nothing parked in quiesce
    },
  };

  return {
    ...host,
    get running(): Slot | null {
      return runningSlot;
    },
    get parked(): boolean {
      return false;
    },
    get startId(): string | null {
      return successor?.startId ?? null;
    },
    async ledger(): Promise<Uint8Array> {
      throw new Error("service adapter has no workload ledger");
    },
    async ledgerState(): Promise<LedgerState> {
      throw new Error("service adapter has no workload ledger");
    },
    lifecycleSurfaces(): ReadbackSurface[] {
      return [
        {
          id: "adapter.autostart",
          read: async () => {
            try {
              const raw = await fs.readFile(autostartPath, "utf8");
              const parsed = JSON.parse(raw) as { enabled: boolean; target: string };
              return {
                value: parsed.enabled ? parsed.target : "",
                source: "adapter.autostart",
              };
            } catch {
              return { value: "", source: "adapter.autostart" };
            }
          },
        },
      ];
    },
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export default createServiceAdapter;
