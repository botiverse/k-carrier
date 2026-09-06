import { spawn } from "node:child_process";
import type { Upgrader, UpgradeOutcome } from "./upgrader.ts";

export interface OneShotResult { outcome: UpgradeOutcome; exitCode: 0 | 1 | 2 }

/** Run one fixed target through K and return a shell-safe terminal status. */
export async function runOneShotUpgrade(upgrader: Upgrader, targetVersion: string, options: { consented?: boolean } = {}): Promise<OneShotResult> {
  if (targetVersion.trim() === "") throw new Error("targetVersion must be explicit");
  try {
    const outcome = await upgrader.upgradeTo(targetVersion, options);
    if (outcome.result === "promoted" || outcome.result === "up-to-date") return { outcome, exitCode: 0 };
    if (outcome.result === "held") return { outcome, exitCode: 2 };
    return { outcome, exitCode: 1 };
  } catch (error) {
    const outcome: UpgradeOutcome = { result: "rolled-back", reason: error instanceof Error ? error.message : "one-shot executor failed", report: null };
    return { outcome, exitCode: 1 };
  }
}

/**
 * Bootstrap seam: execute a downloaded K runner as a separate process and
 * wait for its terminal exit. `detached` is intentionally false; returning
 * before the child exits would turn spawn into a false success signal.
 */
export function execOneShotRunner(command: string, args: readonly string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: "inherit", detached: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 1)));
  });
}
