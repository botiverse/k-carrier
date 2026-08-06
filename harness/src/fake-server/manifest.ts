/**
 * Manifest model — the L0 static-file protocol (design-v1 §L0).
 *
 * A release is described by `manifest.json`: version + per-platform targets
 * (artifact filename, sha256, size). The fake-server serves this plus the
 * artifacts and the full two-level signature chain (keychain.ts).
 *
 * The exact JSON shape here IS the wire contract the core artifact layer
 * will consume; kept in the harness first so the harness is the first
 * consumer (harness-design §0.3 dogfood rule).
 */

import { createHash } from "node:crypto";

export const MANIFEST_FILE = "manifest.json";
/** Signing public key the client needs to verify artifacts (served). */
export const SIGNING_PUB_FILE = "signing.pub";
/** Root's signature over signing.pub — the two-level chain's link. */
export const SIGNING_PUB_SIG_FILE = "signing.pub.sig";
/** Every signed file gets a detached signature next to it. */
export function sigFileFor(file: string): string {
  return `${file}.sig`;
}
/** Machine-readable signature bundle per artifact (consumed by the source). */
export function sigBundleFileFor(file: string): string {
  return `${file}.k-sig.json`;
}

/** One platform's binary target inside a manifest. */
export interface ManifestTarget {
  /** Artifact filename, relative to the release root (served at /<file>). */
  file: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  version: string;
  /** Platform tag (e.g. "darwin-arm64") -> binary target. */
  targets: Record<string, ManifestTarget>;
  /** Track the release was published under (latest | alpha). Optional. */
  /** Explicit opt-out of the signature chain (never a silent default). */
}

export function buildManifest(
  version: string,
  targets: Record<string, ManifestTarget>,
): Manifest {
  const manifest: Manifest = { version, targets };
  return manifest;
}

/** sha256 hex of bytes (Node crypto; zero deps). */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Numeric dotted version compare (1.2.3 < 1.10.0). Enough for the harness's
 * own assertions; the core's anti-rollback policy will own the real rule.
 * Returns -1 / 0 / 1.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => {
    const n = Math.trunc(Number(s));
    return Number.isNaN(n) ? 0 : n;
  });
  const pb = b.split(".").map((s) => {
    const n = Math.trunc(Number(s));
    return Number.isNaN(n) ? 0 : n;
  });
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}
