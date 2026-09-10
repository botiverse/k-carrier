import type { Upgrader } from "../upgrader.ts";
import { OperationReplay, type OperationRead } from "../operation.ts";
import { systemClock, type Clock } from "../clock.ts";
import { parseRunnerRequest, type RunnerRequest, type RunnerResponse } from "../protocol/runner.ts";

export type RunnerUpgrader = Pick<Upgrader, "upgradeTo" | "recover" | "operation">;

async function readOperation(upgrader: RunnerUpgrader): Promise<OperationRead> {
  try { return await upgrader.operation(); }
  catch { return { kind: "unreadable", reason: "cannot read K operation" }; }
}

function receiptCode(read: OperationRead): RunnerResponse["exitCode"] {
  if (read.kind !== "observed") return read.kind === "genesis" ? 0 : 1;
  switch (read.operation.outcome) {
    case "promoted": case "up-to-date": return 0;
    case "held": return 2;
    case null: return 3;
    default: return 1;
  }
}

/** Runs in the disposable helper, never in the resident application's process. */
export async function executeRequest(
  upgrader: RunnerUpgrader, input: RunnerRequest, clock: Clock = systemClock,
): Promise<RunnerResponse> {
  const request = parseRunnerRequest(input);
  let result: string;
  let exitCode: RunnerResponse["exitCode"] = 0;
  try {
    switch (request.action) {
      case "status": result = "observed"; break;
      case "recover": await upgrader.recover(request.expected); result = "recovered"; break;
      case "upgrade": {
        const outcome = await upgrader.upgradeTo(request.targetVersion, {
          consented: request.consented,
          operation: { id: request.id, startedAtMs: clock.nowMs(),
            provenance: { who: "local-operator", carrier: "external-runner" } },
        });
        result = outcome.result;
        exitCode = outcome.result === "held" ? 2 : outcome.result === "rolled-back" ? 1 : 0;
        break;
      }
    }
    const operation = await readOperation(upgrader);
    if (request.action === "upgrade" && exitCode === 0 &&
        (operation.kind !== "observed" || operation.operation.id !== request.id ||
         operation.operation.targetVersion !== request.targetVersion)) {
      throw new Error("RUNNER_RECEIPT_MISMATCH");
    }
    if (request.action !== "status" && exitCode === 0) {
      exitCode = receiptCode(operation);
    }
    if (operation.kind === "unreadable") exitCode = 1;
    return { protocolVersion: 1, action: request.action, result, exitCode, operation, error: null };
  } catch (error) {
    if (error instanceof OperationReplay) {
      const operation: OperationRead = { kind: "observed", operation: error.operation };
      return { protocolVersion: 1, action: request.action, result: "replayed", operation,
        exitCode: receiptCode(operation), error: null };
    }
    const operation = await readOperation(upgrader);
    const recovering = operation.kind === "observed" && operation.operation.outcome === null;
    return { protocolVersion: 1, action: request.action, result: recovering ? "recovery-required" : "failed",
      exitCode: recovering ? 3 : 1, operation,
      error: error instanceof Error ? error.message : "executor failed" };
  }
}
