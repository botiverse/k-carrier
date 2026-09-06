import { execFile } from "node:child_process";
import type { HostAdapter, ProcessEvidence, Slot } from "../lifecycle/hostAdapter.ts";
import { slotArtifactPath } from "../bootstrap.ts";
import { systemClock } from "../clock.ts";
import { platformOpsFor } from "../platform/index.ts";
import { objectValue } from "./protocol.ts";

export interface CommandHostOptions {
  /** Trusted external controller argv. Never a shell expression. */
  command: [string, ...string[]];
  stateDir: string;
  cwd?: string;
  timeoutMs?: number;
}

/** Controller stdin is one JSON request; stdout is one JSON response. */
export function createCommandHost(options: CommandHostOptions): HostAdapter {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000) throw new Error("invalid controller timeout");
  const [file, ...args] = options.command;
  async function call(action: string, slot?: Slot): Promise<Record<string, unknown>> {
    const input = { protocolVersion: 1, action,
      ...(slot ? { slot, artifactPath: slotArtifactPath(options.stateDir, slot) } : {}) };
    const stdout = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let cancel: (() => void) | undefined;
      const child = execFile(file, args, { maxBuffer: 64 * 1024, encoding: "utf8",
        ...(options.cwd ? { cwd: options.cwd } : {}) }, (error, out) => {
        if (settled) return;
        settled = true;
        cancel?.();
        if (error) reject(new Error(`HOST_COMMAND_FAILED: ${action} (${error.code ?? "terminated"})`));
        else resolve(out);
      });
      cancel = systemClock.after(timeout, () => {
        if (settled) return;
        settled = true;
        // A controller ignoring graceful termination cannot hold the helper open.
        // Killing this child does not prove its external effects stopped.
        if (child.pid) {
          try { platformOpsFor().killProcess(child.pid); } catch { /* preserve uncertainty */ }
        }
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        child.unref();
        reject(new Error(`HOST_COMMAND_FAILED: ${action} (deadline exceeded)`));
      });
      child.stdin?.on("error", () => { /* execFile reports early child failure */ });
      child.stdin?.end(JSON.stringify(input));
    });
    const value = objectValue(JSON.parse(stdout));
    if (value.protocolVersion !== 1 || value.ok !== true) throw new Error(`HOST_PROTOCOL_INVALID: ${action}`);
    return value;
  }
  return {
    quiesce: async () => { await call("quiesce"); },
    stop: async (slot) => { await call("stop", slot); },
    start: async (slot) => { await call("start", slot); },
    resume: async () => { await call("resume"); },
    healthProbe: async (): Promise<ProcessEvidence> => {
      const value = objectValue((await call("probe")).evidence);
      if (typeof value.version !== "string" || !value.version || typeof value.startId !== "string" ||
          !value.startId || !Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid <= 0 ||
          value.pid === process.pid) throw new Error("HOST_EVIDENCE_INVALID");
      return { version: value.version, pid: value.pid, startId: value.startId };
    },
  };
}
