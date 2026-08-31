/**
 * L0 download + INTEGRITY only, with RESUME
 * (断点续传 — computer's 150MB SEA case: a process that dies mid-download
 * must not restart from zero).
 *
 * Streams the body to a partial file in `resumeDir` (keyed by the release
 * URL); a later attempt resumes from it via `Range`. The FULL assembled bytes
 * are verified against sha256 + size before being returned, so a corrupted
 * partial is refused rather than trusted for having been "already downloaded".
 * Interruptions leave the partial in place — that is the point; only a
 * completed-but-invalid assembly deletes it. Time goes through the injected
 * Clock, and the deadline is RACED rather than merely signalled (an injected
 * fetch that ignores AbortSignal must not be able to outlive it).
 *
 * ⚠️ K verifies INTEGRITY, never AUTHENTICITY. sha256 + size prove the bytes
 * are the ones the manifest described; they cannot prove WHO produced them,
 * because the digest travels with the artifact from the same place. Signing
 * (a trust root of our own) was implemented and then REMOVED on 2026-08-06 —
 * see docs/design-v1.md §L0.5 for the decision and for why OS code signing
 * (Authenticode / codesign) is a different guarantee, not a substitute.
 *
 * Consequence worth stating where it is used: if the release bucket itself
 * serves wrong bytes — leaked CI credentials, a misconfigured bucket, a
 * poisoned publish pipeline — this check passes and every client installs
 * them.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { type Clock, systemClock } from "../clock.ts";
import { ArtifactError } from "./errors.ts";
import type { Release } from "./source.ts";
import { collectStream } from "./collectStream.ts";
import { partialPathFor } from "./partialPath.ts";
import type { DownloadOptions } from "./transferPolicy.ts";
export { partialPathFor } from "./partialPath.ts";
export type { DownloadOptions } from "./transferPolicy.ts";

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

  const bytes = await fetchAndAppend(
    url, partialPath, partialSize, clock, timeoutMs, opts.onProgress, release.size,
    opts.responseTimeoutMs ?? opts.stallTimeoutMs ?? 0,
    opts.idleTimeoutMs ?? opts.stallTimeoutMs ?? 0,
    opts.fetchImpl ?? fetch,
  );

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
  onProgress?: (downloaded: number, total: number) => void,
  total?: number,
  responseTimeoutMs = 0,
  idleTimeoutMs = 0,
  doFetch: typeof fetch = fetch,
): Promise<Uint8Array> {
  const controller = new AbortController();
  // Body liveness is rearmed on every chunk. `timeoutKind` records WHY we
  // aborted because the abort signal cannot distinguish the three budgets.
  let timeoutKind: "overall" | "response" | "idle" | null = null;
  let responseTimer: (() => void) | undefined;
  let idleTimer: (() => void) | undefined;
  // Invoked when a deadline fires so the pending fetch cannot outlive it.
  let aborted: (() => void) | undefined;
  const abortReason = (u: string): string =>
    timeoutKind === "response"
      ? `download response timed out after ${responseTimeoutMs}ms (awaiting response): ${u}`
      : timeoutKind === "idle"
        ? `download stalled: nothing received for ${idleTimeoutMs}ms (mid-body): ${u}`
        : `download timed out after ${timeoutMs}ms: ${u}`;
  // Declared AFTER `aborted`: an immediate/virtual clock fires this callback
  // synchronously inside `clock.after`, so a timer created earlier would reach
  // `aborted` in its temporal dead zone. Real clocks hide that ordering; the
  // test clock does not.
  const cancel =
    timeoutMs > 0
      ? clock.after(timeoutMs, () => {
          timeoutKind = "overall";
          controller.abort();
          aborted?.();
        })
      : undefined;
  const armResponse = (): void => {
    if (responseTimeoutMs <= 0) return;
    responseTimer?.();
    responseTimer = clock.after(responseTimeoutMs, () => {
      timeoutKind = "response";
      controller.abort();
      aborted?.();
    });
  };
  const armIdle = (): void => {
    if (idleTimeoutMs <= 0) return;
    idleTimer?.();
    idleTimer = clock.after(idleTimeoutMs, () => {
      timeoutKind = "idle";
      controller.abort();
      aborted?.();
    });
  };
  try {
    const headers: Record<string, string> = {};
    if (partialSize > 0) headers["Range"] = `bytes=${partialSize}-`;
    let res: Response;
    armResponse();
    try {
      // Race the abort, do not merely signal it. `AbortSignal` only works if the
      // fetch implementation honours it, and `fetchImpl` is an adopter-supplied
      // seam -- a custom client that ignores the signal would leave every
      // timeout here silently inert, with no way to tell that from a fetch that
      // is simply still working. The deadline has to be enforced by the side
      // that promises it.
      res = await Promise.race([
        doFetch(url, { signal: controller.signal, headers }),
        new Promise<never>((_, reject) => {
          aborted = () => {
            reject(new ArtifactError("DOWNLOAD_FAILED", abortReason(url)));
          };
        }),
      ]);
    } catch (err) {
      const timedOut = controller.signal.aborted;
      throw new ArtifactError(
        "DOWNLOAD_FAILED",
        timedOut ? abortReason(url) : `fetch failed: ${url}`,
        { cause: err },
      );
    }
    if (!res.ok) {
      throw new ArtifactError("DOWNLOAD_FAILED", `GET ${url} -> HTTP ${res.status}`);
    }
    // Headers arriving IS activity: the silence budget covers the gap until the
    // next thing happens, and the response is that thing. Without this rearm a
    // server that answers slowly and then streams normally is killed by a
    // deadline that started before the request was even answered -- and the
    // failure reports "awaiting response" while bytes were on their way.
    responseTimer?.();
    responseTimer = undefined;
    armIdle();

    if (partialPath === null) {
      // Stream even with nowhere to resume to. `res.arrayBuffer()` is one
      // opaque await: no chunk boundaries, so neither the stall timer nor the
      // progress sink can observe anything -- a download without a resumeDir
      // silently had no byte progress and no stall detection at all, while
      // both looked configured.
      try {
        return await collectStream(url, res.body, total, onProgress, armIdle);
      } catch (err) {
        // Same classification as the resume path. Without this the in-memory
        // branch reported a bare stream error, so an abort we ourselves caused
        // (stall or deadline) came back as an anonymous transport failure --
        // the caller could not tell "we gave up on purpose" from "the network
        // broke".
        if (err instanceof ArtifactError) throw err;
        throw new ArtifactError("DOWNLOAD_FAILED", abortReason(url), { cause: err });
      }
    }

    // Resume semantics: only a 206 proves the server honored the Range.
    if (partialSize > 0 && res.status !== 206) {
      await fs.rm(partialPath, { force: true });
      partialSize = 0;
    }
    await fs.mkdir(path.dirname(partialPath), { recursive: true });
    const fh = await fs.open(partialPath, partialSize > 0 ? "a" : "w");
    try {
      // Same rule as the in-memory branch: no readable body is a failure to
      // READ, not an empty download — never hide the cause behind a sha256 mismatch.
      if (!res.body) {
        throw new ArtifactError("DOWNLOAD_FAILED", `response has no readable body: ${url}`);
      }
      // Count from the resumed prefix, never from zero: a bar that restarts
      // reads as "it lost my download" to the person watching it.
      let onDisk = partialSize;
      onProgress?.(onDisk, total ?? 0);
      armIdle();
      await streamToFile(res.body, fh, (chunk) => {
        onDisk += chunk;
        armIdle();
        onProgress?.(onDisk, total ?? 0);
      });
      await fh.sync();
    } catch (err) {
      // A typed error we raised (no readable body) stays typed, like the
      // in-memory branch; only genuine interruptions become "interrupted".
      if (err instanceof ArtifactError) throw err;
      const timedOut = controller.signal.aborted;
      throw new ArtifactError(
        "DOWNLOAD_FAILED",
        timedOut ? abortReason(url) : `download interrupted: ${url}`,
        { cause: err },
      );
    } finally {
      await fh.close();
    }
    return new Uint8Array(await fs.readFile(partialPath));
  } finally {
    cancel?.();
    responseTimer?.();
    idleTimer?.();
  }
}

async function streamToFile(
  body: ReadableStream<Uint8Array>,
  fh: Awaited<ReturnType<typeof fs.open>>,
  onBytes?: (chunk: number) => void,
): Promise<void> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      await fh.write(value);
      onBytes?.(value.byteLength);
    }
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
