/**
 * Production artifact-transfer budgets.
 *
 * Response latency, progress liveness, and total duration answer different
 * questions. Keeping them separate prevents a healthy large transfer from
 * being killed by the same deadline that bounds an unreachable server.
 */
import type { Clock } from "../clock.ts";

export interface DownloadOptions {
  /** Byte progress, including any prefix already present on disk. */
  onProgress?: (downloaded: number, total: number) => void;
  clock?: Clock;
  /** Whole-download bound (0 = off). Legacy direct-call default is 10000. */
  timeoutMs?: number;
  /** Maximum wait for response headers (0 = off). */
  responseTimeoutMs?: number;
  /** Maximum silence between response-body chunks (0 = off). */
  idleTimeoutMs?: number;
  /** Legacy alias for both responseTimeoutMs and idleTimeoutMs. */
  stallTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Directory holding a resumable partial artifact. */
  resumeDir?: string;
}

export interface ArtifactTransferPolicy {
  /** Maximum wait for response headers. */
  responseTimeoutMs: number;
  /** Maximum silence between response-body chunks. */
  idleTimeoutMs: number;
  /** Slowest sustained body rate accepted when deriving the size budget. */
  minimumBytesPerSecond: number;
  /** Absolute ceiling even when the declared artifact is very large. */
  maximumOverallTimeoutMs: number;
}

export interface ArtifactTransferTimeouts {
  responseTimeoutMs: number;
  idleTimeoutMs: number;
  overallTimeoutMs: number;
}

export const DEFAULT_ARTIFACT_TRANSFER_POLICY: ArtifactTransferPolicy = {
  responseTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  minimumBytesPerSecond: 64 * 1024,
  maximumOverallTimeoutMs: 30 * 60_000,
};

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ARTIFACT_TRANSFER_POLICY_INVALID: ${name} must be a positive safe integer`);
  }
}

/** Derive the bounded total budget from the release authority's exact size. */
export function artifactTransferTimeouts(
  artifactSize: number,
  policy: ArtifactTransferPolicy = DEFAULT_ARTIFACT_TRANSFER_POLICY,
): ArtifactTransferTimeouts {
  requirePositiveInteger("artifactSize", artifactSize);
  requirePositiveInteger("responseTimeoutMs", policy.responseTimeoutMs);
  requirePositiveInteger("idleTimeoutMs", policy.idleTimeoutMs);
  requirePositiveInteger("minimumBytesPerSecond", policy.minimumBytesPerSecond);
  requirePositiveInteger("maximumOverallTimeoutMs", policy.maximumOverallTimeoutMs);
  if (policy.maximumOverallTimeoutMs < policy.responseTimeoutMs) {
    throw new Error(
      "ARTIFACT_TRANSFER_POLICY_INVALID: maximumOverallTimeoutMs must cover responseTimeoutMs",
    );
  }

  const bodyBudgetMs = Math.ceil((artifactSize * 1_000) / policy.minimumBytesPerSecond);
  return {
    responseTimeoutMs: policy.responseTimeoutMs,
    idleTimeoutMs: policy.idleTimeoutMs,
    overallTimeoutMs: Math.min(
      policy.maximumOverallTimeoutMs,
      policy.responseTimeoutMs + bodyBudgetMs,
    ),
  };
}

/**
 * The budgets a download runs under. A caller that names any budget gets
 * exactly what it named, as before. A caller that names none gets the
 * budgets K's own engine uses for an artifact of this size: a response
 * deadline, an idle deadline, and an overall deadline that grows with the
 * size. A flat default cannot be right for both a manifest and a 150 MB
 * binary.
 */
export function resolveDownloadBudgets(
  size: number,
  opts: Pick<DownloadOptions, "timeoutMs" | "responseTimeoutMs" | "idleTimeoutMs" | "stallTimeoutMs">,
): { timeoutMs: number; responseTimeoutMs: number; idleTimeoutMs: number } {
  const named = opts.timeoutMs !== undefined || opts.responseTimeoutMs !== undefined
    || opts.idleTimeoutMs !== undefined || opts.stallTimeoutMs !== undefined;
  if (!named && Number.isSafeInteger(size) && size > 0) {
    const t = artifactTransferTimeouts(size);
    return { timeoutMs: t.overallTimeoutMs, responseTimeoutMs: t.responseTimeoutMs, idleTimeoutMs: t.idleTimeoutMs };
  }
  return {
    timeoutMs: opts.timeoutMs ?? 10000,
    responseTimeoutMs: opts.responseTimeoutMs ?? opts.stallTimeoutMs ?? 0,
    idleTimeoutMs: opts.idleTimeoutMs ?? opts.stallTimeoutMs ?? 0,
  };
}
