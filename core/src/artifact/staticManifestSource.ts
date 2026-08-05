/**
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
import { parseManifest, type Manifest } from "./manifest.ts";
import { ArtifactError } from "./errors.ts";
import type { Release, ReleaseContext, ReleaseSource } from "./source.ts";

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
