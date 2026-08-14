/**
 * First-adoption bootstrap for an already-running service.
 *
 * K normally owns both slots from the first install. An existing application
 * adopting K has a different starting world: trusted bytes are running, but
 * `slots/stable` does not exist yet. Starting the first transaction in that
 * world would make a failed experiment roll back to an empty slot.
 *
 * `bootstrapStable` closes that one-time gap. It copies the application's
 * current trusted executable into K's stable slot before any transaction can
 * start. The publication is atomic and shares K's upgrade lock, so a crash
 * leaves either no stable slot or one complete stable slot, never half of one.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { platformOpsFor } from "./platform/index.ts";
import { acquireUpgradeLock } from "./txn/lock.ts";
import { slotArtifactPath } from "./txn/fileEffects.ts";

const VERSION_FILE = "VERSION";

export type BootstrapStableResult = "bootstrapped" | "already-initialized";

export type BootstrapErrorCode =
  | "BOOTSTRAP_VERSION_INVALID"
  | "BOOTSTRAP_STATE_CONFLICT"
  | "BOOTSTRAP_SOURCE_UNREADABLE"
  | "BOOTSTRAP_WRITE_FAILED";

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = "BootstrapError";
    this.code = code;
  }
}

export interface BootstrapStableOptions {
  /** Directory K owns for its journal, slots, and staging area. */
  stateDir: string;
  /** Version of the trusted executable that is running before K adoption. */
  version: string;
  /** Path to those exact trusted executable bytes. */
  artifactPath: string;
  /** Clock seam used only for the shared upgrade-lock receipt. */
  nowMs?: () => number;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readInitializedStable(stateDir: string): Promise<string | null> {
  const stableDir = path.join(stateDir, "slots", "stable");
  if (!(await pathExists(stableDir))) return null;

  let version: string;
  try {
    version = (await fs.readFile(path.join(stableDir, VERSION_FILE), "utf8")).trim();
    await fs.stat(slotArtifactPath(stateDir, "stable"));
  } catch (error) {
    throw new BootstrapError(
      "BOOTSTRAP_STATE_CONFLICT",
      "the stable slot exists but is incomplete; refusing to overwrite recovery evidence",
      { cause: error },
    );
  }
  if (version.length === 0) {
    throw new BootstrapError(
      "BOOTSTRAP_STATE_CONFLICT",
      "the stable slot has an empty version; refusing to overwrite recovery evidence",
    );
  }
  return version;
}

async function assertPristineTransactionState(stateDir: string): Promise<void> {
  const conflicting = [
    path.join(stateDir, "journal.jsonl"),
    path.join(stateDir, "slots", "experiment"),
  ];
  for (const candidate of conflicting) {
    if (await pathExists(candidate)) {
      throw new BootstrapError(
        "BOOTSTRAP_STATE_CONFLICT",
        `transaction state already exists at ${candidate}; refusing to invent an initial stable slot`,
      );
    }
  }
}

/**
 * Seed K's stable slot exactly once from an application's current trusted
 * executable. A complete existing stable slot means K is already initialized
 * (possibly at a newer version), so the caller's old carrier bytes are ignored.
 */
export async function bootstrapStable(opts: BootstrapStableOptions): Promise<BootstrapStableResult> {
  const version = opts.version.trim();
  if (version.length === 0) {
    throw new BootstrapError("BOOTSTRAP_VERSION_INVALID", "version must be non-empty");
  }

  const lock = await acquireUpgradeLock(opts.stateDir, (opts.nowMs ?? Date.now)());
  try {
    if ((await readInitializedStable(opts.stateDir)) !== null) return "already-initialized";
    await assertPristineTransactionState(opts.stateDir);

    try {
      const source = await fs.stat(opts.artifactPath);
      if (!source.isFile()) throw new Error("bootstrap source is not a regular file");
    } catch (error) {
      throw new BootstrapError(
        "BOOTSTRAP_SOURCE_UNREADABLE",
        `trusted bootstrap artifact is not readable at ${opts.artifactPath}`,
        { cause: error },
      );
    }

    const slotsDir = path.join(opts.stateDir, "slots");
    const stableDir = path.join(slotsDir, "stable");
    const stagingDir = `${stableDir}.bootstrap`;
    const stagingArtifact = path.join(stagingDir, "artifact.bin");
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.copyFile(opts.artifactPath, stagingArtifact);
      const artifactHandle = await fs.open(stagingArtifact, "r+");
      try {
        await artifactHandle.sync();
      } finally {
        await artifactHandle.close();
      }
      await platformOpsFor().makeExecutable(stagingArtifact);

      const versionHandle = await fs.open(path.join(stagingDir, VERSION_FILE), "w");
      try {
        await versionHandle.writeFile(version);
        await versionHandle.sync();
      } finally {
        await versionHandle.close();
      }
      await fs.mkdir(slotsDir, { recursive: true });
      await platformOpsFor().renamePath(stagingDir, stableDir);
      return "bootstrapped";
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof BootstrapError) throw error;
      throw new BootstrapError(
        "BOOTSTRAP_WRITE_FAILED",
        "could not atomically publish the initial stable slot",
        { cause: error },
      );
    }
  } finally {
    await lock.release();
  }
}

/** Public slot resolver used by host adapters; layout remains K-owned. */
export { slotArtifactPath } from "./txn/fileEffects.ts";
