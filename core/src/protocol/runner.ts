import { parseOperation, type OperationRead } from "../operation.ts";

/** Wire version is independent of the helper and application release versions. */
export const RUNNER_PROTOCOL_VERSION = 1;
export type RunnerRequest =
  | { protocolVersion: 1; action: "upgrade"; id: string; targetVersion: string; consented: boolean }
  | { protocolVersion: 1; action: "recover"; expected?: { id: string; targetVersion: string } }
  | { protocolVersion: 1; action: "status" }
;

export interface RunnerResponse {
  protocolVersion: 1;
  action: RunnerRequest["action"];
  /** 0 = completed command, 1 = failure/unknown, 2 = hold, 3 = recovery needed. */
  exitCode: 0 | 1 | 2 | 3;
  result: string;
  /** Verbatim K receipt; an exception never manufactures a rollback receipt. */
  operation: OperationRead;
  error: string | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNNER_PROTOCOL_INVALID: expected an object");
  }
  return value as Record<string, unknown>;
}

function textField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 256) {
    throw new Error(`RUNNER_PROTOCOL_INVALID: invalid ${field}`);
  }
  return value;
}

/** Reject unknown versions and fields before loading an adapter or touching disk. */
export function parseRunnerRequest(input: unknown): RunnerRequest {
  const value = objectValue(input);
  if (value.protocolVersion !== RUNNER_PROTOCOL_VERSION) throw new Error("RUNNER_PROTOCOL_UNSUPPORTED");
  const keys = value.action === "upgrade" ? ["protocolVersion", "action", "id", "targetVersion", "consented"] : value.action === "recover" ? ["protocolVersion", "action", "expected"] : ["protocolVersion", "action"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("RUNNER_PROTOCOL_INVALID: unknown field");
  switch (value.action) {
    case "upgrade":
      if (typeof value.consented !== "boolean") throw new Error("RUNNER_PROTOCOL_INVALID: consented must be boolean");
      return { protocolVersion: 1, action: "upgrade", id: textField(value.id, "id"),
        targetVersion: textField(value.targetVersion, "targetVersion"), consented: value.consented };
    case "recover": {
      if (value.expected === undefined) return { protocolVersion: 1, action: "recover" };
      const expected = objectValue(value.expected);
      if (Object.keys(expected).some((key) => !["id", "targetVersion"].includes(key))) throw new Error("RUNNER_PROTOCOL_INVALID: unknown expected field");
      return { protocolVersion: 1, action: "recover", expected: {
        id: textField(expected.id, "id"), targetVersion: textField(expected.targetVersion, "targetVersion"),
      } };
    }
    case "status":
      return { protocolVersion: 1, action: value.action };
    default: throw new Error("RUNNER_PROTOCOL_INVALID: unknown action");
  }
}

/** The supervisor accepts only a complete, typed runner response. */
export function parseRunnerResponse(input: unknown): RunnerResponse {
  const value = objectValue(input);
  if (value.protocolVersion !== 1 || !["upgrade", "recover", "status"].includes(String(value.action)) ||
      ![0, 1, 2, 3].includes(Number(value.exitCode)) || typeof value.exitCode !== "number" ||
      typeof value.result !== "string" || !(value.error === null || typeof value.error === "string")) {
    throw new Error("RUNNER_RESPONSE_INVALID");
  }
  const read = objectValue(value.operation);
  let operation: OperationRead;
  switch (read.kind) {
    case "genesis": operation = { kind: "genesis" }; break;
    case "unreadable":
      if (typeof read.reason !== "string") throw new Error("RUNNER_RESPONSE_INVALID");
      operation = { kind: "unreadable", reason: read.reason }; break;
    case "observed": operation = { kind: "observed", operation: parseOperation(JSON.stringify(read.operation)) }; break;
    default: throw new Error("RUNNER_RESPONSE_INVALID");
  }
  return { protocolVersion: 1, action: value.action as RunnerRequest["action"],
    exitCode: value.exitCode as RunnerResponse["exitCode"], result: value.result, error: value.error, operation };
}
