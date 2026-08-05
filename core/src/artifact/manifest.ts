/**
 * L0 manifest model — the static-file protocol wire contract
 * (design-v1 §L0): `manifest.json` = version + per-platform targets
 * (file/sha256/size).
 *
 * NOTE ON OWNERSHIP: this format belongs to `staticManifestSource`, not to K.
 * A ReleaseSource that fetches releases some other way (a private API, date
 * -stamped paths, an OCI registry) never parses this at all. K itself has no
 * manifest concept — only "the source told me version, url, sha256, size".
 *
 * Parsing is strict and fail-closed: a malformed manifest or an unknown
 * malformed field is a typed error, never a silent reinterpretation.
 * Unknown EXTRA keys are ignored (forward compatibility — the required
 * shape is version + targets).
 */
import { ArtifactError } from "./errors.ts";

export interface ManifestTarget {
  /** Artifact filename relative to the release root (served at /<file>). */
  file: string;
  /** Lowercase hex sha256 of the artifact bytes (64 chars). */
  sha256: string;
  size: number;
}

export interface Manifest {
  version: string;
  /** Platform tag (e.g. "darwin-arm64") -> binary target. */
  targets: Record<string, ManifestTarget>;
  /** Track the release was published under (latest | alpha). Optional. */
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function parseManifest(text: string): Manifest {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new ArtifactError("MANIFEST_INVALID", "manifest is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null) {
    throw new ArtifactError("MANIFEST_INVALID", "manifest must be a JSON object");
  }
  const o = obj as Record<string, unknown>;

  if (typeof o.version !== "string" || o.version.trim() === "") {
    throw new ArtifactError("MANIFEST_INVALID", "manifest.version must be a non-empty string");
  }
  if (typeof o.targets !== "object" || o.targets === null) {
    throw new ArtifactError("MANIFEST_INVALID", "manifest.targets must be an object");
  }
  const targets: Manifest["targets"] = {};
  for (const [platform, raw] of Object.entries(o.targets as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      throw new ArtifactError("MANIFEST_INVALID", `targets.${platform} must be an object`);
    }
    const t = raw as Record<string, unknown>;
    if (typeof t.file !== "string" || t.file.trim() === "") {
      throw new ArtifactError("MANIFEST_INVALID", `targets.${platform}.file must be a non-empty string`);
    }
    if (typeof t.sha256 !== "string" || !SHA256_RE.test(t.sha256)) {
      throw new ArtifactError("MANIFEST_INVALID", `targets.${platform}.sha256 must be 64-char hex`);
    }
    if (typeof t.size !== "number" || !Number.isInteger(t.size) || t.size < 0) {
      throw new ArtifactError("MANIFEST_INVALID", `targets.${platform}.size must be a non-negative integer`);
    }
    targets[platform] = { file: t.file, sha256: t.sha256, size: t.size };
  }
  if (Object.keys(targets).length === 0) {
    throw new ArtifactError("MANIFEST_INVALID", "manifest.targets must contain at least one platform");
  }

  const out: Manifest = { version: o.version, targets };
  return out;
}

/** The platform key the client resolves against (os-arch, e.g. darwin-arm64). */
export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}
