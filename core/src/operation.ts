/**
 * K-owned durable operation receipt.
 *
 * Hosts may project this record into their own UI or transport, but they do
 * not maintain a second upgrade state machine. The operation receipt is the
 * single durable answer to: what is running, which version was requested,
 * what stable version can be restored, and whether the terminal receipt has
 * already been acknowledged by the host transport.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { platformOpsFor } from "./platform/index.ts";
import type { ProvenanceIdentity } from "./upgrader.ts";

const OPERATION_FILE = "operation.json";
export const OPERATION_FORMAT_VERSION = 1;

export type OperationPhase =
  | "checking"
  | "downloading"
  | "verifying"
  | "staging"
  | "handing-over"
  | "probing"
  | "recovering"
  | "promoted"
  | "rolled-back"
  | "held"
  | "up-to-date"
  | "failed";

export type OperationOutcome = "promoted" | "rolled-back" | "held" | "up-to-date" | "failed";

const OPERATION_PHASES = new Set<OperationPhase>([
  "checking",
  "downloading",
  "verifying",
  "staging",
  "handing-over",
  "probing",
  "recovering",
  "promoted",
  "rolled-back",
  "held",
  "up-to-date",
  "failed",
]);
const OPERATION_OUTCOMES = new Set<OperationOutcome>([
  "promoted",
  "rolled-back",
  "held",
  "up-to-date",
  "failed",
]);

export interface OperationDescriptor {
  id: string;
  startedAtMs: number;
  provenance?: ProvenanceIdentity;
  /** Opaque non-secret host correlation fields (for example server/request ids). */
  metadata?: Record<string, string>;
}

export interface OperationRecord {
  formatVersion: typeof OPERATION_FORMAT_VERSION;
  id: string;
  startedAtMs: number;
  updatedAtMs: number;
  fromVersion: string;
  targetVersion: string;
  /** The stable version that was current when this operation began. */
  previousStableVersion: string;
  phase: OperationPhase;
  outcome: OperationOutcome | null;
  reason: string | null;
  provenance: ProvenanceIdentity | null;
  metadata: Record<string, string>;
  /** Host transport receipt, not a second transaction outcome. */
  acknowledgedAtMs: number | null;
}

export type OperationRead =
  | { kind: "genesis" }
  | { kind: "observed"; operation: OperationRecord }
  | { kind: "unreadable"; reason: string };

function operationPath(stateDir: string): string {
  return path.join(stateDir, OPERATION_FILE);
}

function validIdentity(value: unknown): value is ProvenanceIdentity {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as ProvenanceIdentity).who === "string"
    && typeof (value as ProvenanceIdentity).carrier === "string",
  );
}

function parseOperation(text: string): OperationRecord {
  const parsed = JSON.parse(text) as Partial<OperationRecord>;
  if (
    parsed.formatVersion !== OPERATION_FORMAT_VERSION
    || typeof parsed.id !== "string"
    || parsed.id.length === 0
    || typeof parsed.startedAtMs !== "number"
    || !Number.isFinite(parsed.startedAtMs)
    || typeof parsed.updatedAtMs !== "number"
    || !Number.isFinite(parsed.updatedAtMs)
    || typeof parsed.fromVersion !== "string"
    || typeof parsed.targetVersion !== "string"
    || typeof parsed.previousStableVersion !== "string"
    || typeof parsed.phase !== "string"
    || !OPERATION_PHASES.has(parsed.phase as OperationPhase)
    || !(parsed.outcome === null || (
      typeof parsed.outcome === "string"
      && OPERATION_OUTCOMES.has(parsed.outcome as OperationOutcome)
    ))
    || !(parsed.reason === null || typeof parsed.reason === "string")
    || !(parsed.provenance === null || validIdentity(parsed.provenance))
    || typeof parsed.metadata !== "object"
    || parsed.metadata === null
    || Array.isArray(parsed.metadata)
    || Object.values(parsed.metadata).some((value) => typeof value !== "string")
    || !(parsed.acknowledgedAtMs === null || typeof parsed.acknowledgedAtMs === "number")
  ) {
    throw new Error("operation record has an invalid shape");
  }
  return parsed as OperationRecord;
}

/** Atomic and durable replacement. K's upgrade lock serializes writers. */
export async function persistOperation(stateDir: string, operation: OperationRecord): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const target = operationPath(stateDir);
  const tmp = `${target}.tmp`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(operation));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await platformOpsFor().renamePath(tmp, target);
}

export async function loadOperation(stateDir: string): Promise<OperationRead> {
  let text: string;
  try {
    text = await fs.readFile(operationPath(stateDir), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "genesis" };
    return { kind: "unreadable", reason: `cannot read ${OPERATION_FILE} (${code ?? (error as Error).message})` };
  }
  try {
    return { kind: "observed", operation: parseOperation(text) };
  } catch (error) {
    return { kind: "unreadable", reason: `corrupt ${OPERATION_FILE}: ${(error as Error).message}` };
  }
}

export async function acknowledgeOperation(
  stateDir: string,
  operationId: string,
  acknowledgedAtMs: number,
): Promise<"acknowledged" | "not-terminal" | "not-found" | "changed"> {
  const current = await loadOperation(stateDir);
  if (current.kind === "genesis") return "not-found";
  if (current.kind === "unreadable") throw new Error(current.reason);
  if (current.operation.id !== operationId) return "changed";
  if (current.operation.outcome === null) return "not-terminal";
  // Exact replay is idempotent. The first delivery time is part of the audit
  // receipt; a retry must not rewrite it or manufacture a later delivery.
  if (current.operation.acknowledgedAtMs !== null) return "acknowledged";
  await persistOperation(stateDir, {
    ...current.operation,
    updatedAtMs: acknowledgedAtMs,
    acknowledgedAtMs,
  });
  return "acknowledged";
}
