/**
 * L0 artifact layer errors — every failure is typed (fail-closed: an
 * unknown channel, a tampered artifact, a half-written swap all carry a
 * machine-readable code, never a silent pass).
 */
export type ArtifactErrorCode =
  | "MANIFEST_INVALID"
  | "CHANNEL_INVALID"
  | "PINNED_VERSION_MISMATCH"
  | "CHANNEL_NOT_IN_MANIFEST"
  | "CHANNEL_VERSION_MISMATCH"
  | "UNSUPPORTED_PLATFORM"
  | "DOWNLOAD_FAILED"
  | "SHA256_MISMATCH"
  | "SIZE_MISMATCH"
  | "SWAP_FAILED";

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = "ArtifactError";
    this.code = code;
  }
}
