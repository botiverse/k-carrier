import { promises as fs } from "node:fs";
import path from "node:path";
import { loadOperation } from "./operation.ts";
import { acquireUpgradeLock, type UpgradeLock } from "./txn/lock.ts";
import { UpgradeLockError } from "./txn/lock.ts";
import { platformOpsFor } from "./platform/index.ts";

export type QuarantineResult =
  | { status: "quarantined"; sourcePath: string; quarantinePath: string; operationId: string; timestampMs: number }
  | { status: "already-quarantined"; sourcePath: string; quarantinePath: string; operationId: string; timestampMs: number }
  | { status: "not-found"; sourcePath: string; quarantinePath: string; operationId: string; timestampMs: number };

export type QuarantineErrorCode =
  | "QUARANTINE_INVALID_DESTINATION"
  | "QUARANTINE_DESTINATION_CONFLICT"
  | "QUARANTINE_ACTIVE_OPERATION"
  | "QUARANTINE_ACTIVE_LOCK"
  | "QUARANTINE_STATE_UNREADABLE"
  | "QUARANTINE_WRITE_FAILED";

export class QuarantineError extends Error {
  readonly code: QuarantineErrorCode;

  constructor(code: QuarantineErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = "QuarantineError";
    this.code = code;
  }
}

export interface QuarantineOptions {
  /** Absolute destination. It must be outside stateDir and must not exist. */
  destination: string;
  /** Timestamp supplied by the host clock so the receipt is deterministic. */
  timestampMs: number;
  /** Host proof run while K's single-writer lock is held. */
  assertActiveHandoff?: () => Promise<void>;
}

function assertDestination(stateDir: string, destination: string): void {
  if (!path.isAbsolute(destination)) {
    throw new QuarantineError("QUARANTINE_INVALID_DESTINATION", "destination must be absolute");
  }
  const source = path.resolve(stateDir);
  const target = path.resolve(destination);
  if (source === target || target.startsWith(`${source}${path.sep}`)) {
    throw new QuarantineError("QUARANTINE_INVALID_DESTINATION", "destination must be outside stateDir");
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface QuarantineReceipt {
  formatVersion: 1;
  kind: "k-fresh-install-quarantine";
  sourcePath: string;
  quarantinePath: string;
  operationId: string;
  timestampMs: number;
}

async function readReceipt(destination: string): Promise<QuarantineReceipt | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(destination, "fresh-install-quarantine.json"), "utf8")) as Partial<QuarantineReceipt>;
    if (parsed.formatVersion !== 1 || parsed.kind !== "k-fresh-install-quarantine" || typeof parsed.sourcePath !== "string" || typeof parsed.quarantinePath !== "string" || typeof parsed.operationId !== "string" || typeof parsed.timestampMs !== "number") return null;
    return parsed as QuarantineReceipt;
  } catch {
    return null;
  }
}

/**
 * Move the complete K state directory to an audit-only quarantine.
 *
 * The state lock is acquired before the terminal check and the directory
 * rename is one filesystem operation. The lock release is ownership-aware, so
 * a new state directory created immediately after the rename cannot have its
 * lock removed by the old holder. Active operations are never killed or
 * silently detached; callers must first complete the host handoff contract.
 */
export async function quarantineState(stateDir: string, options: QuarantineOptions): Promise<QuarantineResult> {
  assertDestination(stateDir, options.destination);
  const timestampMs = options.timestampMs;
  const sourcePath = path.resolve(stateDir);
  const quarantinePath = path.resolve(options.destination);
  const existingDestination = await exists(quarantinePath);
  const existingOperation = await loadOperation(sourcePath);
  const operationId = existingOperation.kind === "observed" ? existingOperation.operation.id : "genesis";

  if (existingDestination) {
    if (await exists(sourcePath)) {
      throw new QuarantineError("QUARANTINE_DESTINATION_CONFLICT", `destination already exists: ${quarantinePath}`);
    }
    const receipt = await readReceipt(quarantinePath);
    if (receipt === null) throw new QuarantineError("QUARANTINE_DESTINATION_CONFLICT", `destination has no valid quarantine receipt: ${quarantinePath}`);
    return { status: "already-quarantined", sourcePath: receipt.sourcePath, quarantinePath: receipt.quarantinePath, operationId: receipt.operationId, timestampMs: receipt.timestampMs };
  }
  if (!(await exists(sourcePath))) {
    return { status: "not-found", sourcePath, quarantinePath, operationId, timestampMs };
  }

  let lock: UpgradeLock | null = null;
  try {
    lock = await acquireUpgradeLock(sourcePath, timestampMs);
    const operation = await loadOperation(sourcePath);
    if (operation.kind === "unreadable") {
      throw new QuarantineError("QUARANTINE_STATE_UNREADABLE", operation.reason);
    }
    if (operation.kind === "observed" && operation.operation.outcome === null) {
      if (options.assertActiveHandoff === undefined) {
        throw new QuarantineError(
          "QUARANTINE_ACTIVE_OPERATION",
          `operation ${operation.operation.id} is active; complete host handoff before quarantine`,
        );
      }
      try {
        await options.assertActiveHandoff();
      } catch (error) {
        throw new QuarantineError("QUARANTINE_ACTIVE_OPERATION", `active operation ${operation.operation.id} handoff was not proven`, { cause: error });
      }
    }
    if (await exists(quarantinePath)) {
      throw new QuarantineError("QUARANTINE_DESTINATION_CONFLICT", `destination already exists: ${quarantinePath}`);
    }
    await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
    const receipt: QuarantineReceipt = {
      formatVersion: 1,
      kind: "k-fresh-install-quarantine",
      sourcePath,
      quarantinePath,
      operationId: operation.kind === "observed" ? operation.operation.id : "genesis",
      timestampMs,
    };
    const receiptPath = path.join(sourcePath, "fresh-install-quarantine.json");
    const fh = await fs.open(receiptPath, "w");
    try {
      await fh.writeFile(JSON.stringify(receipt));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await platformOpsFor().renamePath(sourcePath, quarantinePath);
    return {
      status: "quarantined",
      sourcePath,
      quarantinePath,
      operationId: receipt.operationId,
      timestampMs,
    };
  } catch (error) {
    if (error instanceof QuarantineError) throw error;
    if (error instanceof UpgradeLockError) {
      throw new QuarantineError("QUARANTINE_ACTIVE_LOCK", error.message, { cause: error });
    }
    throw new QuarantineError("QUARANTINE_WRITE_FAILED", `could not quarantine ${sourcePath}`, { cause: error });
  } finally {
    await lock?.release();
  }
}
