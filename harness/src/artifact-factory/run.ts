/**
 * Guarded artifact execution — run a built demo binary as a real child
 * process, capturing stdout and exit code, with a hard timeout kill (a
 * hang-on-quiesce artifact must never hang the harness).
 *
 * This is the minimal process-management primitive the factory teeth need;
 * the fake-host daemon (harness/src/fake-host/) will later standardize the
 * full spawn/probe/pgrep conventions on top of it.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";

export interface RunResult {
  stdout: string;
  /** Exit code, or null if the process was killed by timeout / failed to spawn. */
  code: number | null;
  timedOut: boolean;
}

export function runArtifact(artifactPath: string, timeoutMs = 5000): Promise<RunResult> {
  const nodeBin = path.dirname(process.execPath);
  const child = spawn(artifactPath, [], {
    env: { ...process.env, PATH: `${nodeBin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  let stdout = "";
  let timedOut = false;
  child.stdout.on("data", (d: Buffer) => {
    stdout += String(d);
  });
  child.stderr.on("data", () => {
    // stderr is intentionally ignored by callers; stdout carries the report
  });
  return new Promise<RunResult>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, code, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, code: null, timedOut });
    });
  });
}
