/**
 * Real-process fake host (harness-design §1.1, second form).
 *
 * Spawns daemon-entry.ts as a genuine OS process, so the properties that
 * only exist in process reality are actually exercised:
 *   - kill -9 (SIGKILL) really terminates; recovery faces real leftovers
 *   - dual-run is detected by asking the OS, not by reading our own bookkeeping
 *   - probe liveness is bound to a real pid + per-incarnation startId
 *   - "verify dead" means the OS says gone, not that we sent a signal
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { HostAdapter, ProcessEvidence, Slot } from "../../../core/src/lifecycle/hostAdapter.ts";

const ENTRY = path.join(import.meta.dirname, "daemon-entry.ts");

interface Incarnation {
  child: ChildProcess;
  slot: Slot;
  version: string;
  pid: number;
  startId: string;
}

export interface DaemonHostOptions {
  /** Version each slot's "binary" reports when started. */
  slotVersions: Record<Slot, string | null>;
  /** Milliseconds before a start/probe is considered hung. */
  timeoutMs?: number;
  /** Extra env for spawned incarnations (e.g. the sandbox marker). */
  env?: Record<string, string>;
}

/** Does the OS still know this pid? (Signal 0 = existence check, no delivery.) */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class DaemonFakeHost implements HostAdapter {
  private current: Incarnation | null = null;
  private readonly opts: DaemonHostOptions;
  /** Every pid we ever started, for leak/dual-run auditing. */
  readonly startedPids: number[] = [];

  constructor(opts: DaemonHostOptions) {
    this.opts = opts;
  }

  async quiesce(): Promise<void> {
    // No workload ledger in the process tier; the in-proc host covers that.
  }

  async stop(_slot: Slot): Promise<void> {
    const inc = this.current;
    if (!inc) return;
    this.current = null;
    inc.child.kill("SIGKILL");
    await this.waitUntilDead(inc.pid);
  }

  async start(slot: Slot): Promise<void> {
    const version = this.opts.slotVersions[slot];
    if (version === null) throw new Error(`slot ${slot} holds no version to start`);
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, ...this.opts.env, K_FAKE_VERSION: version, K_FAKE_SLOT: slot },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const ready = await this.readLine(child, "ready", this.opts.timeoutMs ?? 5000);
    const info = JSON.parse(ready) as { pid: number; startId: string };
    this.current = { child, slot, version, pid: info.pid, startId: info.startId };
    this.startedPids.push(info.pid);
  }

  async healthProbe(): Promise<ProcessEvidence> {
    const inc = this.current;
    if (!inc) throw new Error("no live incarnation to probe");
    inc.child.stdin?.write("probe\n");
    const line = await this.readLine(inc.child, "evidence", this.opts.timeoutMs ?? 5000);
    return JSON.parse(line) as ProcessEvidence;
  }

  async resume(): Promise<void> {}

  /** SIGKILL the live incarnation without any orderly shutdown (crash sim). */
  async crash(): Promise<number | null> {
    const inc = this.current;
    if (!inc) return null;
    this.current = null;
    inc.child.kill("SIGKILL");
    await this.waitUntilDead(inc.pid);
    return inc.pid;
  }

  /** Teardown contract: kill everything we started and PROVE it is gone. */
  async teardownVerifyDead(): Promise<{ killed: number[]; survivors: number[] }> {
    await this.crash();
    const survivors: number[] = [];
    for (const pid of this.startedPids) {
      if (processAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone between the check and the signal
        }
        await this.waitUntilDead(pid, 2000).catch(() => survivors.push(pid));
      }
    }
    return { killed: this.startedPids.filter((p) => !survivors.includes(p)), survivors };
  }

  /** Pids we started that the OS still reports alive (dual-run auditing). */
  livePids(): number[] {
    return this.startedPids.filter((pid) => processAlive(pid));
  }

  private async waitUntilDead(pid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (processAlive(pid)) {
      if (Date.now() > deadline) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
      await new Promise((r) => {
        setTimeout(r, 10);
      });
    }
  }

  private readLine(child: ChildProcess, prefix: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for "${prefix}" from fake daemon`));
      }, timeoutMs);
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        for (const line of buffer.split("\n")) {
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
}
