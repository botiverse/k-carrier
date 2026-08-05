/**
 * Release selection — K defines the MECHANISM, the adopter defines the
 * VOCABULARY.
 *
 * K ships no channel names. "stable", "nightly", "lts-2024", "unstable" —
 * whatever your release streams are called is your business; K only looks
 * the name up in your manifest. A name your manifest does not publish fails
 * closed rather than falling back to something we guessed.
 *
 * Two kinds of selector, because pinning is not a channel:
 *   - channel:  follow a named stream, take whatever version it points at
 *   - pinned:   bypass stream resolution and demand one exact version
 */
import { ArtifactError } from "./errors.ts";
import type { Manifest, ManifestTarget } from "./manifest.ts";

export type ReleaseSelector =
  | { readonly kind: "channel"; readonly name: string }
  | { readonly kind: "pinned"; readonly version: string };

/** Parse the adopter's configured selector. `pinned:X` is the one reserved prefix. */
export function parseSelector(input: string): ReleaseSelector {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ArtifactError("CHANNEL_INVALID", "release selector is empty");
  }
  if (trimmed.startsWith("pinned:")) {
    const version = trimmed.slice("pinned:".length).trim();
    if (!version) {
      throw new ArtifactError("CHANNEL_INVALID", `pinned selector needs a version: ${JSON.stringify(input)}`);
    }
    return { kind: "pinned", version };
  }
  // Any other string is a channel name the adopter owns. K does not
  // validate it against a list it invented; the manifest is the authority.
  return { kind: "channel", name: trimmed };
}

export interface ResolvedTarget {
  version: string;
  platform: string;
  target: ManifestTarget;
}

/**
 * Resolve a selector against the served manifest.
 *
 * Channel resolution consults `manifest.channels` (name -> version) when the
 * publisher provides it. A single-stream publisher may omit `channels`
 * entirely and serve one version; in that case ONLY a channel whose name the
 * manifest declares is accepted — we never assume "the served version must be
 * what you asked for".
 */
export function resolveSelector(
  manifest: Manifest,
  selector: ReleaseSelector,
  platformKey: string,
): ResolvedTarget {
  if (selector.kind === "pinned") {
    if (manifest.version !== selector.version) {
      throw new ArtifactError(
        "PINNED_VERSION_MISMATCH",
        `pinned ${selector.version} but the server serves ${manifest.version}`,
      );
    }
  } else {
    const declared = manifest.channels?.[selector.name];
    if (declared === undefined) {
      const known = Object.keys(manifest.channels ?? {});
      throw new ArtifactError(
        "CHANNEL_NOT_IN_MANIFEST",
        `channel ${JSON.stringify(selector.name)} is not published in this manifest (published: ${known.join(", ") || "none"})`,
      );
    }
    if (declared !== manifest.version) {
      throw new ArtifactError(
        "CHANNEL_VERSION_MISMATCH",
        `channel ${selector.name} points at ${declared} but the manifest body serves ${manifest.version}`,
      );
    }
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
