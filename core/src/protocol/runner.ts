import type { OperationRead } from "../operation.ts";

/** Wire version is independent of the helper and application release versions. */
export const RUNNER_PROTOCOL_VERSION = 1;
export type RunnerRequest =
  | { protocolVersion: 1; action: "upgrade"; id: string; targetVersion: string; consented: boolean }
  | { protocolVersion: 1; action: "recover" | "status" }
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
  const keys = value.action === "upgrade" ? ["protocolVersion", "action", "id", "targetVersion", "consented"] : ["protocolVersion", "action"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("RUNNER_PROTOCOL_INVALID: unknown field");
  switch (value.action) {
    case "upgrade":
      if (typeof value.consented !== "boolean") throw new Error("RUNNER_PROTOCOL_INVALID: consented must be boolean");
      return { protocolVersion: 1, action: "upgrade", id: textField(value.id, "id"),
        targetVersion: textField(value.targetVersion, "targetVersion"), consented: value.consented };
    case "recover":
    case "status":
      return { protocolVersion: 1, action: value.action };
    default: throw new Error("RUNNER_PROTOCOL_INVALID: unknown action");
  }
}
