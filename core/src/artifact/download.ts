/**
 * L0 download + integrity (test-plan M1: sha256 不符拒装). Downloads the
 * artifact over HTTP and verifies sha256 + size against the manifest
 * before returning — a tampered artifact is REFUSED, never handed on.
 *
 * Time goes through the injected Clock (the core clock seam — default real
 * system clock); a hung download aborts after the timeout instead of
 * hanging the caller (harness lesson: hangs are bugs).
 */
import { createHash } from "node:crypto";
import { type Clock, systemClock } from "../clock.ts";
import { ArtifactError } from "./errors.ts";
import type { Release } from "./source.ts";

export interface DownloadOptions {
  clock?: Clock;
  /** Abort the download after this many ms (0 = no timeout). Default 10000. */
  timeoutMs?: number;
}

/**
 * Fetch and verify one release's bytes. Takes a Release (url + sha256 + size)
 * because that is exactly what a ReleaseSource returns — K does not compose
 * URLs from a base, since it does not own the publisher's layout.
 */
export async function downloadVerified(
  release: Release,
  opts: DownloadOptions = {},
): Promise<Uint8Array> {
  const url = release.url;
  const bytes = await fetchWithTimeout(url, opts.clock ?? systemClock, opts.timeoutMs ?? 10000);

  const sha = sha256Hex(bytes);
  if (sha !== release.sha256) {
    throw new ArtifactError(
      "SHA256_MISMATCH",
      `sha256 of ${url} does not match the release (got ${sha.slice(0, 12)}…, expected ${release.sha256.slice(0, 12)}…)`,
    );
  }
  if (bytes.length !== release.size) {
    throw new ArtifactError(
      "SIZE_MISMATCH",
      `size of ${url} (${bytes.length}) does not match manifest (${release.size})`,
    );
  }
  return bytes;
}

async function fetchWithTimeout(url: string, clock: Clock, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const cancel = timeoutMs > 0 ? clock.after(timeoutMs, () => controller.abort()) : undefined;
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      throw new ArtifactError(
        "DOWNLOAD_FAILED",
        timedOut ? `download timed out after ${timeoutMs}ms: ${url}` : `fetch failed: ${url}`,
        { cause: err },
      );
    }
    if (!res.ok) {
      throw new ArtifactError("DOWNLOAD_FAILED", `GET ${url} -> HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    cancel?.();
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
