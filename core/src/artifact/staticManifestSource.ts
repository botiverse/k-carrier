/**
 * staticManifestSource — and the manifest.json format itself.
 *
 * The format lives HERE, not in a neutral core module, because it is this
 * source's format: a ReleaseSource that reads a private API, date-stamped
 * paths or an OCI registry never parses a manifest at all. Keeping it in
 * core/artifact/manifest.ts implied K owned it, which was misleading.
 *
 * staticManifestSource — a batteries-included ReleaseSource for the common
 * case: one static file host, one stream, semver ordering.
 *
 * This is ONE POLICY, not framework law. It encodes choices K has no business
 * making for everyone:
 *   - versions are semver and ordered as such
 *   - "should I upgrade" means "is the served version greater than mine"
 *   - downgrades are refused here (explicit downgrade goes through
 *     upgradeTo/fetchRelease instead)
 *
 * Publish releases under a different scheme (dates, build numbers), or across
 * several streams, and you write your own ReleaseSource — without touching K.
 */
import { ArtifactError } from "./errors.ts";

import type { Release, ReleaseContext, ReleaseSource } from "./source.ts";

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

export interface StaticManifestSourceOptions {
  /** Base URL holding manifest.json and the artifacts, e.g. https://cdn.x/mytool/stable */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

function numericParts(v: string): number[] {
  return v.split("-")[0]!.split(".").map((n) => Math.trunc(Number(n)) || 0);
}

/** Compare two dotted numeric versions; returns >0 when a is newer. */
function compareSemver(a: string, b: string): number {
  const [pa, pb] = [numericParts(a), numericParts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A prerelease (1.2.3-rc.1) sorts BELOW its release (1.2.3).
  const preA = a.includes("-");
  const preB = b.includes("-");
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

function releaseFrom(manifest: Manifest, baseUrl: string, platformKey: string): Release {
  const target = manifest.targets[platformKey];
  if (!target) {
    throw new ArtifactError(
      "UNSUPPORTED_PLATFORM",
      `manifest has no target for ${platformKey} (have: ${Object.keys(manifest.targets).join(", ") || "none"})`,
    );
  }
  return {
    version: manifest.version,
    url: `${baseUrl.replace(/\/$/u, "")}/${target.file}`,
    sha256: target.sha256,
    size: target.size,
  };
}

export function staticManifestSource(opts: StaticManifestSourceOptions): ReleaseSource {
  const base = opts.baseUrl.replace(/\/$/u, "");
  const doFetch = opts.fetchImpl ?? fetch;

  async function loadManifest(): Promise<Manifest> {
    const res = await doFetch(`${base}/manifest.json`);
    if (!res.ok) {
      throw new ArtifactError("DOWNLOAD_FAILED", `manifest.json fetch failed: HTTP ${res.status}`);
    }
    return parseManifest(await res.text());
  }

  return {
    async checkForUpdate(ctx: ReleaseContext): Promise<Release | null> {
      const manifest = await loadManifest();
      // POLICY: only move forward. A served version older than ours is not an
      // "update" — taking it silently would be an automatic downgrade.
      if (compareSemver(manifest.version, ctx.currentVersion) <= 0) return null;
      return releaseFrom(manifest, base, ctx.platformKey);
    },

    async fetchRelease(version: string, ctx: ReleaseContext): Promise<Release> {
      const manifest = await loadManifest();
      if (manifest.version !== version) {
        throw new ArtifactError(
          "PINNED_VERSION_MISMATCH",
          `asked for ${version} but this source serves ${manifest.version}`,
        );
      }
      return releaseFrom(manifest, base, ctx.platformKey);
    },
  };
}
