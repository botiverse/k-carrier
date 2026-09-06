import type { Readable, Writable } from "node:stream";
import { parseRunnerRequest } from "./protocol.ts";
import { runOneShotUpgrade, type RunnerUpgrader } from "./runner.ts";

/** Build-time adapter factory; request JSON can never name code to import. */
export async function serveRunner(
  create: () => Promise<RunnerUpgrader> | RunnerUpgrader,
  input: Readable = process.stdin, output: Writable = process.stdout,
): Promise<number> {
  try {
    let text = "";
    for await (const chunk of input) {
      text += String(chunk);
      if (text.length > 16_384) throw new Error("RUNNER_REQUEST_TOO_LARGE");
    }
    const request = parseRunnerRequest(JSON.parse(text));
    const response = await runOneShotUpgrade(await create(), request);
    await new Promise<void>((resolve, reject) => {
      output.write(`${JSON.stringify(response)}\n`, (error) => error ? reject(error) : resolve());
    });
    return response.exitCode;
  } catch (error) {
    output.write(`${JSON.stringify({ protocolVersion: 1, result: "failed", exitCode: 1,
      error: error instanceof Error ? error.message : "runner failed" })}\n`);
    return 1;
  }
}
