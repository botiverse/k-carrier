/**
 * artifact-factory (harness-design §1.77) — build-once, stamp-many release
 * production for upgrade tests.
 *
 * `makeRelease({version, behavior})` stamps the demo source into a REAL
 * binary (version string injected into the artifact's own bytes — the same
 * shape as SEA-embedded versions), then publishes it with manifest + full
 * signature chain into a ReleaseStore (the fake-server's store).
 *
 * The `behavior` knob bakes deliberate breakage into "new versions":
 * crash-on-start / wrong-version-probe / hang-on-quiesce are the fixture
 * source for rollback teeth and self-verification known-red/adversarial
 * samples ("升到坏版本→自动回滚→stable 完好" must be black-box reproducible).
 *
 * Content-addressed cache (key = source hash × version × behavior) makes
 * repeated requests cheap and byte-identical across scenarios. Stamping is
 * fully deterministic — Ed25519 signing is deterministic too, so the whole
 * published release (artifact + manifest + signatures) is reproducible.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DEMO_SOURCE } from "./demo.ts";
import { sha256Hex } from "../fake-server/manifest.ts";
import { ReleaseStore, type PublishReleaseSpec } from "../fake-server/store.ts";

export const BEHAVIORS = [
  "ok",
  "crash-on-start",
  "wrong-version-probe",
  "hang-on-quiesce",
] as const;

export type Behavior = (typeof BEHAVIORS)[number];

export interface MakeReleaseOptions {
  version: string;
  behavior: Behavior;
  /** The release lands here (the fake-server's store). */
  store: ReleaseStore;
  /** Manifest platform tag. Default: "current". */
  platform?: string;
}

export interface FactoryRelease {
  /** Artifact filename inside the release (served at /<file>). */
  artifactFile: string;
  artifactBytes: Uint8Array;
  sha256: string;
  /** True when the content-addressed cache served this request. */
  cached: boolean;
}

interface CacheMeta {
  version: string;
  behavior: Behavior;
  artifactFile: string;
  sha256: string;
}

export class ArtifactFactory {
  private readonly source: string;
  private readonly sourceHash: string;
  private readonly cacheDir: string;
  private buildCount = 0;

  constructor(opts: { demoSource?: string; cacheDir: string }) {
    this.source = opts.demoSource ?? DEMO_SOURCE;
    this.sourceHash = sha256Hex(new TextEncoder().encode(this.source));
    this.cacheDir = opts.cacheDir;
  }

  /** Number of actual stamps performed (cache hits don't count). */
  get builds(): number {
    return this.buildCount;
  }

  async makeRelease(opts: MakeReleaseOptions): Promise<FactoryRelease> {
    const key = `${this.sourceHash}:${opts.version}:${opts.behavior}`;
    const keyHash = sha256Hex(new TextEncoder().encode(key));
    const binPath = path.join(this.cacheDir, `${keyHash}.bin`);
    const metaPath = path.join(this.cacheDir, `${keyHash}.json`);

    let meta: CacheMeta;
    let bytes: Uint8Array;
    let cached = false;
    const metaRaw = await fs.readFile(metaPath).catch(() => null);
    if (metaRaw) {
      meta = JSON.parse(new TextDecoder().decode(metaRaw)) as CacheMeta;
      bytes = new Uint8Array(await fs.readFile(binPath));
      cached = true;
    } else {
      await fs.mkdir(this.cacheDir, { recursive: true });
      bytes = stamp(this.source, opts.version, opts.behavior);
      meta = {
        version: opts.version,
        behavior: opts.behavior,
        artifactFile: artifactFileName(opts.version),
        sha256: sha256Hex(bytes),
      };
      await fs.writeFile(binPath, bytes, { mode: 0o755 });
      await fs.writeFile(metaPath, JSON.stringify(meta));
      this.buildCount += 1;
    }

    if (!opts.store.has(opts.version)) {
      const spec: PublishReleaseSpec = {
        version: opts.version,
        artifacts: { [meta.artifactFile]: bytes },
        binary: meta.artifactFile,
        executable: true,
      };
      if (opts.platform !== undefined) spec.platform = opts.platform;
      await opts.store.publish(spec);
    }

    return {
      artifactFile: meta.artifactFile,
      artifactBytes: bytes,
      sha256: meta.sha256,
      cached,
    };
  }
}

export function artifactFileName(version: string): string {
  return `app-${version}.bin`;
}

/** Replace the stamp placeholders; the only byte-varying step, fully deterministic. */
export function stamp(source: string, version: string, behavior: Behavior): Uint8Array {
  const stamped = source.replaceAll("__K_VERSION__", version).replaceAll("__K_BEHAVIOR__", behavior);
  return new TextEncoder().encode(stamped);
}
