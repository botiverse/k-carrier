/**
 * Guarded command execution — run a binary/command as a real child
 * process, capturing stdout/stderr and exit code, with a hard timeout
 * kill (a hang-on-quiesce artifact must never hang the harness).
 *
 * This is the process-management primitive the harness needs across the
 * board: the factory teeth run bare artifacts, the black-box --bin mode
 * runs the binary's declared commands with args + env. The fake-host
 * daemon (harness/src/fake-host/) will later standardize the full
 * spawn/probe/pgrep conventions on top of it.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null if the process was killed by timeout / failed to spawn. */
  code: number | null;
  timedOut: boolean;
}

export interface RunOptions {
  /** Extra env vars (merged over process.env). */
  env?: Record<string, string>;
  /** Hard timeout; the child is SIGKILLed past it. Default 5000ms. */
  timeoutMs?: number;
}

/** PATH with the running node's bin dir first (shebang `env node` works). */
function nodeFirstPath(): string {
  const nodeBin = path.dirname(process.execPath);
  return `${nodeBin}${path.delimiter}${process.env.PATH ?? ""}`;
}

export function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const child = spawn(cmd, args, {
    env: { ...process.env, PATH: nodeFirstPath(), ...opts.env },
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (d: Buffer) => {
    stdout += String(d);
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += String(d);
  });
  return new Promise<RunResult>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 5000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut });
    });
  });
}

/** Run a bare artifact with no args (factory teeth convenience). */
export function runArtifact(artifactPath: string, timeoutMs = 5000): Promise<RunResult> {
  return runCommand(artifactPath, [], { timeoutMs });
}
