import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HostCallTimeout, HostCallUncertain } from "../txn/hostCallBudget.ts";
import type { HostAdapter, ProcessEvidence, Slot } from "./hostAdapter.ts";
import { slotArtifactPath } from "../bootstrap.ts";
import { systemClock } from "../clock.ts";
import { platformOpsFor } from "../platform/index.ts";
function controllerObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HOST_PROTOCOL_INVALID: expected an object");
  }
  return value as Record<string, unknown>;
}

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
  const controllersDir = path.join(options.stateDir, "controllers");
  async function drainControllers(): Promise<void> {
    await fs.mkdir(controllersDir, { recursive: true });
    const deadline = systemClock.nowMs() + timeout;
    for (const name of await fs.readdir(controllersDir)) {
      const controllerPath = path.join(controllersDir, name);
      const pid = Number(name.split("-")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("HOST_FENCE_UNRESOLVED: invalid controller evidence");
      while (platformOpsFor().isProcessAlive(pid)) {
        if (systemClock.nowMs() >= deadline) throw new HostCallTimeout("fence", timeout);
        await new Promise<void>((resolve) => { systemClock.after(Math.min(50, timeout), resolve); });
      }
      await fs.rm(controllerPath, { force: true });
    }
  }
  async function call(action: string, slot?: Slot): Promise<Record<string, unknown>> {
    const input = { protocolVersion: 1, action,
      ...(slot ? { slot, artifactPath: slotArtifactPath(options.stateDir, slot) } : {}) };
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}) });
    const controllerPath = path.join(controllersDir, `${child.pid}-${randomUUID()}.json`);
    let exited = false;
    let cancel: (() => void) | undefined;
    let stdout = "";
    const done = new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", () => { exited = true; });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 64 * 1024) reject(new HostCallUncertain("HOST_RESPONSE_TOO_LARGE"));
      });
      child.stderr.resume();
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`HOST_COMMAND_FAILED: ${action} (${code})`)));
    });
    // Install rejection handlers before filesystem IO or an early spawn failure.
    void done.catch(() => {});
    child.stdin.on("error", () => {});
    try {
      if (!child.pid) return await done.then(() => { throw new Error("HOST_SPAWN_FAILED"); });
      await fs.mkdir(controllersDir, { recursive: true });
      const handle = await fs.open(controllerPath, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: child.pid })); await handle.sync(); }
      finally { await handle.close(); }
      // No controller gets a command before its lifetime is recorded. A worker
      // dying before this point closes stdin without authorizing any effect.
      child.stdin.end(JSON.stringify(input));
      stdout = await Promise.race([done, new Promise<never>((_resolve, reject) => {
        cancel = systemClock.after(timeout, () => reject(new HostCallTimeout(action, timeout)));
      })]);
    } finally {
      cancel?.();
      if (!exited && child.pid) {
        try { platformOpsFor().killProcess(child.pid); } catch { /* fence will verify */ }
      }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      // On uncertain termination retain the process evidence for the next fence.
      if (exited) await fs.rm(controllerPath, { force: true });
    }
    const value = controllerObject(JSON.parse(stdout));
    if (value.protocolVersion !== 1 || value.ok !== true) throw new Error(`HOST_PROTOCOL_INVALID: ${action}`);
    return value;
  }
  return {
    fence: async () => {
      await drainControllers();
      // The controller must also fence detached/queued service-manager effects;
      // absence of its old PID alone does not establish that condition.
      await call("fence");
    },
    quiesce: async () => { await call("quiesce"); },
    stop: async (slot) => { await call("stop", slot); },
    start: async (slot) => { await call("start", slot); },
    resume: async () => { await call("resume"); },
    healthProbe: async (): Promise<ProcessEvidence> => {
      const value = controllerObject((await call("probe")).evidence);
      if (typeof value.version !== "string" || !value.version || typeof value.startId !== "string" ||
          !value.startId || !Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid <= 0 ||
          value.pid === process.pid) throw new Error("HOST_EVIDENCE_INVALID");
      return { version: value.version, pid: value.pid, startId: value.startId };
    },
  };
}
