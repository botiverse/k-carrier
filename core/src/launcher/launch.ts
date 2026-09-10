import { superviseRunner, type RunnerLaunch } from "./supervise.ts";
export { superviseRunner, resumeRunner } from "./supervise.ts";
export type { RunnerLaunch, RunnerLaunchResult } from "./supervise.ts";

/** Installer entrypoint: one final response and an honest recovery exit code. */
export async function launchRunner(input: RunnerLaunch): Promise<number> {
  const result = await superviseRunner(input);
  const response = result.error ? { protocolVersion: 1, action: input.request.action,
    exitCode: 3, result: "recovery-required", error: result.error,
    operation: result.response?.operation ?? { kind: "unreadable", reason: "worker returned no usable receipt" },
    recoveryFile: result.recoveryFile } : result.response;
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  if (result.error) process.stderr.write(`${result.error}; recovery: ${result.recoveryFile}\n`);
  return result.exitCode;
}
