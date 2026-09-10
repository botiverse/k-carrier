import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Release } from "../artifact/source.ts";
import { downloadVerified } from "../artifact/download.ts";
import { artifactTransferTimeouts } from "../artifact/transferPolicy.ts";
import { parseRunnerRequest, parseRunnerResponse, type RunnerRequest, type RunnerResponse } from "../protocol/runner.ts";
import { platformOpsFor } from "../platform/index.ts";
import { systemClock } from "../clock.ts";

export interface RunnerLaunch {
  release: Release;
  request: RunnerRequest;
  scratchDir: string;
  interpreter?: string;
  /** Finite worker, recovery-attempt and overall execution budgets. */
  executionTimeoutMs?: number;
  recoveryTimeoutMs?: number;
  totalTimeoutMs?: number;
  recoveryAttempts?: number;
}

export interface RunnerLaunchResult {
  exitCode: number;
  response: RunnerResponse | null;
  /** Retained verified helper + invocation; no transaction state is copied. */
  recoveryFile: string | null;
  error: string | null;
  attempts: number;
}

interface Attempt { code: number; response: RunnerResponse | null; fenced: boolean }

function budget(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new Error("invalid runner budget");
  return result;
}

/** A worker is reaped before a successor is allowed. Controller effects are
 * separately fenced by the adapter under K's lock, including after a restart. */
async function run(file: string, interpreter: string | undefined, request: RunnerRequest, timeout: number): Promise<Attempt> {
  return new Promise((resolve) => {
    const child = spawn(interpreter ?? file, interpreter ? [file] : [], { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    let exited = false;
    let expired = false;
    let finished = false;
    let cancelGrace: (() => void) | undefined;
    const finish = (code: number, fenced: boolean): void => {
      if (finished) return;
      finished = true;
      cancel(); cancelGrace?.();
      child.stdin.destroy(); child.stdout.destroy(); child.unref();
      let response: RunnerResponse | null = null;
      if (!expired) {
        try { response = parseRunnerResponse(JSON.parse(output)); }
        catch { /* a missing/malformed response cannot settle a transaction */ }
      }
      if (response && (response.action !== request.action || response.exitCode !== code)) response = null;
      resolve({ code, response, fenced });
    };
    const terminate = (): void => {
      if (expired || finished) return;
      expired = true;
      if (child.pid && !exited) {
        try { platformOpsFor().killProcess(child.pid); } catch { /* require observed exit */ }
      }
      child.stdin.destroy(); child.stdout.destroy();
      cancelGrace = systemClock.after(1000, () => finish(3, exited));
    };
    const cancel = systemClock.after(timeout, terminate);
    child.on("error", () => finish(1, child.pid === undefined));
    child.on("exit", () => { exited = true; });
    child.on("close", (code) => finish(expired ? 3 : code ?? 1, exited || child.pid === undefined));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 64 * 1024) terminate();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

function settled(response: RunnerResponse | null, request: RunnerRequest): boolean {
  if (!response || response.error !== null) return false;
  const expected = request.action === "upgrade" ? request : request.action === "recover" ? request.expected : undefined;
  if (!expected) return response.exitCode !== 3 && response.operation.kind !== "unreadable" &&
    (response.operation.kind === "genesis" || response.operation.operation.outcome !== null);
  if (response.operation.kind !== "observed") return false;
  const op = response.operation.operation;
  const code = op.outcome === "promoted" || op.outcome === "up-to-date" ? 0 : op.outcome === "held" ? 2 : 1;
  return op.id === expected.id && op.targetVersion === expected.targetVersion && op.outcome !== null && response.exitCode === code;
}

/** Own one install until a bound receipt or explicit unresolved recovery. */
export async function superviseRunner(input: RunnerLaunch): Promise<RunnerLaunchResult> {
  const request = parseRunnerRequest(input.request);
  const execution = budget(input.executionTimeoutMs, 600_000);
  const recovery = budget(input.recoveryTimeoutMs, 120_000);
  const total = budget(input.totalTimeoutMs, execution + recovery * 2);
  const retries = input.recoveryAttempts ?? 2;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) throw new Error("invalid recovery attempts");
  const transfer = artifactTransferTimeouts(input.release.size);
  const bytes = await downloadVerified(input.release, { timeoutMs: transfer.overallTimeoutMs,
    responseTimeoutMs: transfer.responseTimeoutMs, idleTimeoutMs: transfer.idleTimeoutMs });
  await fs.mkdir(input.scratchDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(input.scratchDir, "k-runner-"));
  const file = path.join(dir, input.interpreter ? "runner.mjs" : "runner.bin");
  const recoveryFile = path.join(dir, "recovery.json");
  const expected = request.action === "upgrade" ? { id: request.id, targetVersion: request.targetVersion } :
    request.action === "recover" ? request.expected : undefined;
  const recoverRequest: RunnerRequest = { protocolVersion: 1, action: "recover", ...(expected ? { expected } : {}) };
  // Retain enough trusted distribution metadata to verify and recover offline.
  // This is an invocation descriptor, never another transaction log.
  const artifact = await fs.open(file, "wx", 0o700);
  try { await artifact.writeFile(bytes); await artifact.sync(); }
  finally { await artifact.close(); }
  await platformOpsFor().makeExecutable(file);
  const handle = await fs.open(recoveryFile, "w", 0o600);
  try { await handle.writeFile(JSON.stringify({ file, interpreter: input.interpreter,
    sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, request: recoverRequest })); await handle.sync(); }
  finally { await handle.close(); }
  const deadline = systemClock.nowMs() + total;
  let response: RunnerResponse | null = null;
  let attempts = 0;
  for (; attempts <= retries; attempts++) {
    const remaining = deadline - systemClock.nowMs();
    if (remaining <= 0) break;
    const attempt = await run(file, input.interpreter, attempts === 0 ? request : recoverRequest,
      Math.min(remaining, attempts === 0 ? execution : recovery));
    response = attempt.response;
    if (attempt.fenced && (request.action === "status" || settled(response, request))) {
      await fs.rm(dir, { force: true, recursive: true });
      const exitCode = request.action === "status" && !response && attempt.code === 0 ? 1 : attempt.code;
      return { exitCode, response, recoveryFile: null, error: null, attempts: attempts + 1 };
    }
    if (!attempt.fenced || !expected) { attempts++; break; }
  }
  return { exitCode: 3, response, recoveryFile, attempts,
    error: "RECOVERY_UNRESOLVED: retained helper and invocation; transaction evidence is unchanged" };
}

/** Resume the retained, hash-verified helper without distribution access. */
export async function resumeRunner(recoveryFile: string, options: Pick<RunnerLaunch,
  "executionTimeoutMs" | "recoveryTimeoutMs" | "totalTimeoutMs" | "recoveryAttempts"> = {}): Promise<RunnerLaunchResult> {
  const descriptor = JSON.parse(await fs.readFile(recoveryFile, "utf8")) as {
    file: string; interpreter?: string; sha256: string; size: number; request: RunnerRequest;
  };
  const request = parseRunnerRequest(descriptor.request);
  if (request.action !== "recover" || !request.expected ||
      typeof descriptor.file !== "string" || (descriptor.interpreter !== undefined && typeof descriptor.interpreter !== "string")) {
    throw new Error("INVALID_RECOVERY_DESCRIPTOR");
  }
  const bytes = await fs.readFile(descriptor.file);
  if (bytes.length !== descriptor.size || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
    throw new Error("RECOVERY_ARTIFACT_MISMATCH");
  }
  const result = await superviseRunner({ ...options, request,
    ...(descriptor.interpreter ? { interpreter: descriptor.interpreter } : {}),
    scratchDir: path.dirname(path.dirname(recoveryFile)), release: { version: "retained-runner",
      url: `data:application/octet-stream;base64,${bytes.toString("base64")}`, size: descriptor.size, sha256: descriptor.sha256 } });
  if (!result.recoveryFile) {
    // Remove only the files this descriptor owns, never its caller's directory.
    await fs.rm(descriptor.file, { force: true });
    await fs.rm(recoveryFile, { force: true });
  }
  return result;
}
