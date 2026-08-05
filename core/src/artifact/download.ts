/**
 * L0 download + integrity (test-plan M1: sha256 不符拒装), with RESUME
 * (断点续传 — computer's 150MB SEA case: a process that dies mid-download
 * must not restart from zero).
 *
 * Downloads the artifact over HTTP, streaming the body to a partial file in
 * `resumeDir` (keyed by the release URL). A later attempt resumes from the
 * partial via a `Range` request instead of re-downloading the prefix. The
 * FULL assembled bytes are verified against the release's sha256 + size
 * before they are returned — a corrupted partial (or a tampered resume
 * server) is REFUSED and the partial deleted, so a bad prefix is never
 * trusted just because it was "already downloaded".
 *
 * Interruptions (timeout / process death) leave the partial in place —
 * that is the whole point. Only a COMPLETED-but-invalid assembly deletes it.
 *
 * Time goes through the injected Clock (the core clock seam); a hung
 * download aborts after the timeout instead of hanging the caller.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { type Clock, systemClock } from "../clock.ts";
import { ArtifactError } from "./errors.ts";
import type { Release } from "./source.ts";

export interface DownloadOptions {
  clock?: Clock;
  /** Abort the download after this many ms (0 = no timeout). Default 10000. */
  timeoutMs?: number;
  /**
   * Directory for partial-download state. When set, an interrupted download
   * leaves its prefix here and the next attempt resumes via Range.
   */
  resumeDir?: string;
}

/** The partial-download file for a release URL (the naming rule lives here). */
export function partialPathFor(resumeDir: string, url: string): string {
  return path.join(resumeDir, `${sha256Hex(new TextEncoder().encode(url))}.part`);
}

/** Fetch and verify one release's bytes, resuming from a partial if present. */
export async function downloadVerified(
  release: Release,
  opts: DownloadOptions = {},
): Promise<Uint8Array> {
  const url = release.url;
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.timeoutMs ?? 10000;

  const partialPath = opts.resumeDir ? partialPathFor(opts.resumeDir, url) : null;

  let partialSize = 0;
  if (partialPath) {
    try {
      partialSize = (await fs.stat(partialPath)).size;
    } catch {
      // no partial yet
    }
    if (partialSize >= release.size) partialSize = 0; // complete/over-long is not a resume point
  }

  const bytes = await fetchAndAppend(url, partialPath, partialSize, clock, timeoutMs);

  const sha = sha256Hex(bytes);
  if (sha !== release.sha256) {
    // A completed-but-invalid assembly is useless and must not be resumed:
    // delete the partial so the next attempt starts clean.
    if (partialPath) await fs.rm(partialPath, { force: true }).catch(() => {});
    throw new ArtifactError(
      "SHA256_MISMATCH",
      `sha256 of ${url} does not match the release (got ${sha.slice(0, 12)}…, expected ${release.sha256.slice(0, 12)}…)`,
    );
  }
  if (bytes.length !== release.size) {
    if (partialPath) await fs.rm(partialPath, { force: true }).catch(() => {});
    throw new ArtifactError(
      "SIZE_MISMATCH",
      `size of ${url} (${bytes.length}) does not match manifest (${release.size})`,
    );
  }
  return bytes;
}

/**
 * Fetch and stream into the partial file (appending when resuming). On
 * interruption the partial is left in place; the file handle is always
 * closed. 206 = the server honored the Range; 200 = it ignored it (a fresh
 * download, so the partial is discarded).
 */
async function fetchAndAppend(
  url: string,
  partialPath: string | null,
  partialSize: number,
  clock: Clock,
  timeoutMs: number,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const cancel = timeoutMs > 0 ? clock.after(timeoutMs, () => controller.abort()) : undefined;
  try {
    const headers: Record<string, string> = {};
    if (partialSize > 0) headers["Range"] = `bytes=${partialSize}-`;
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal, headers });
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

    if (partialPath === null) {
      return new Uint8Array(await res.arrayBuffer());
    }

    // Resume semantics: only a 206 proves the server honored the Range.
    if (partialSize > 0 && res.status !== 206) {
      await fs.rm(partialPath, { force: true });
      partialSize = 0;
    }
    await fs.mkdir(path.dirname(partialPath), { recursive: true });
    const fh = await fs.open(partialPath, partialSize > 0 ? "a" : "w");
    try {
      if (res.body) await streamToFile(res.body, fh);
      await fh.sync();
    } catch (err) {
      // interrupted (abort / connection drop): the prefix stays in the
      // partial for the next attempt
      const timedOut = controller.signal.aborted;
      throw new ArtifactError(
        "DOWNLOAD_FAILED",
        timedOut ? `download timed out after ${timeoutMs}ms: ${url}` : `download interrupted: ${url}`,
        { cause: err },
      );
    } finally {
      await fh.close();
    }
    return new Uint8Array(await fs.readFile(partialPath));
  } finally {
    cancel?.();
  }
}

async function streamToFile(
  body: ReadableStream<Uint8Array>,
  fh: Awaited<ReturnType<typeof fs.open>>,
): Promise<void> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) await fh.write(value);
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
