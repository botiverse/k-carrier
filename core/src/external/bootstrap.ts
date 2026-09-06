import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { downloadVerified } from "../artifact/download.ts";
import type { Release } from "../artifact/source.ts";
import { artifactTransferTimeouts } from "../artifact/transferPolicy.ts";
import { parseRunnerRequest, type RunnerRequest } from "./protocol.ts";
import { platformOpsFor } from "../platform/index.ts";

export interface RunnerLaunch {
  /** Native helper, or a bundled JS helper with an independently installed Node. */
  release: Release;
  request: RunnerRequest;
  /** Caller-owned executable scratch area outside BOTH application slots. */
  scratchDir: string;
  interpreter?: string;
}

/** Download -> integrity check -> execute once -> wait -> remove disposable bytes. */
export async function execOneShotRunner(input: RunnerLaunch): Promise<number> {
  const request = parseRunnerRequest(input.request);
  const budgets = artifactTransferTimeouts(input.release.size);
  const bytes = await downloadVerified(input.release, { timeoutMs: budgets.overallTimeoutMs,
    responseTimeoutMs: budgets.responseTimeoutMs, idleTimeoutMs: budgets.idleTimeoutMs });
  await fs.mkdir(input.scratchDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(input.scratchDir, "k-runner-"));
  const file = path.join(dir, input.interpreter ? "runner.mjs" : "runner.bin");
  try {
    await fs.writeFile(file, bytes, { mode: 0o700 });
    await platformOpsFor().makeExecutable(file);
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(input.interpreter ?? file, input.interpreter ? [file] : [], {
        stdio: ["pipe", "inherit", "inherit"], detached: false,
      });
      child.stdin.on("error", () => { /* early exit is reported by close/error */ });
      child.stdin.end(JSON.stringify(request));
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}
