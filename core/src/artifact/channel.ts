/**
 * L0 channel resolution (test-plan M1: latest | alpha | pinned:X with
 * Version XOR Track semantics — a release is either pinned to a version
 * or followed by track; unknown channel values fail closed).
 *
 *  - `latest`: take the served manifest's version (whatever the server
 *    publishes as current).
 *  - `alpha`: the served manifest must itself be published as an alpha
 *    release (manifest.channel === "alpha"), else fail closed.
 *  - `pinned:X`: the served manifest version must equal X, else fail
 *    closed (the server is not serving what the pin demands).
 */
import { ArtifactError } from "./errors.ts";
import type { Manifest, ManifestTarget } from "./manifest.ts";

export type Channel = "latest" | "alpha" | `pinned:${string}`;

export function parseChannel(input: string): Channel {
  if (input === "latest" || input === "alpha") return input;
  if (input.startsWith("pinned:")) {
    const version = input.slice("pinned:".length);
    if (!version.trim()) {
      throw new ArtifactError("CHANNEL_INVALID", `pinned channel needs a version: ${JSON.stringify(input)}`);
    }
    return input as Channel;
  }
  throw new ArtifactError(
    "CHANNEL_INVALID",
    `unknown channel ${JSON.stringify(input)} (expected latest | alpha | pinned:X)`,
  );
}

export interface ResolvedTarget {
  version: string;
  platform: string;
  target: ManifestTarget;
}

/** Resolve the manifest to a concrete target for `channel` + `platformKey`. */
export function resolveTarget(manifest: Manifest, channel: Channel, platformKey: string): ResolvedTarget {
  if (channel.startsWith("pinned:")) {
    const pinned = channel.slice("pinned:".length);
    if (manifest.version !== pinned) {
      throw new ArtifactError(
        "PINNED_VERSION_MISMATCH",
        `pinned ${pinned} but server serves ${manifest.version}`,
      );
    }
  } else if (channel === "alpha" && manifest.channel !== "alpha") {
    throw new ArtifactError(
      "NOT_ALPHA",
      `channel alpha but the served manifest is not an alpha release (channel: ${manifest.channel ?? "latest"})`,
    );
  }
  const target = manifest.targets[platformKey];
  if (!target) {
    throw new ArtifactError(
      "UNSUPPORTED_PLATFORM",
      `manifest has no target for platform ${platformKey} (have: ${Object.keys(manifest.targets).join(", ") || "none"})`,
    );
  }
  return { version: manifest.version, platform: platformKey, target };
}
