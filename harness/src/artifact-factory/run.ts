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
import { closeSync, openSync, readSync } from "node:fs";
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

/**
 * How to spawn an artifact on THIS platform.
 *
 * The factory's demo artifact is a single node script whose first line is a
 * `#!/usr/bin/env node` shebang — one file, one sha256, swappable bytes. On
 * POSIX the kernel honors the shebang, so the artifact is spawned directly
 * (which also keeps the exec-bit reality exercised). Windows has no shebang:
 * spawning the file raises EFTYPE. Routing through the running node binary
 * keeps the ARTIFACT BYTES identical on every platform — only the execution
 * convention forks, never the artifact model.
 *
 * The sniff is content-based (leading `#!` + "node" on the shebang line), not
 * extension-based, because the artifact deliberately has no extension. A real
 * adopter binary on Windows is a PE `.exe` — no `#!` — and spawns directly.
 * An unreadable file falls through to a direct spawn so missing-target
 * failure semantics stay exactly what the caller would have seen.
 */
export function commandForArtifact(filePath: string, args: string[]): { cmd: string; args: string[] } {
  if (process.platform !== "win32") return { cmd: filePath, args };
  try {
    const fd = openSync(filePath, "r");
    try {
      const head = Buffer.alloc(64);
      const n = readSync(fd, head, 0, head.length, 0);
      const firstLine = head.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
      if (firstLine.startsWith("#!") && firstLine.includes("node")) {
        return { cmd: process.execPath, args: [filePath, ...args] };
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // unreadable/missing: spawn directly and let the caller see the real error
  }
  return { cmd: filePath, args };
}

export function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const routed = commandForArtifact(cmd, args);
  const child = spawn(routed.cmd, routed.args, {
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
