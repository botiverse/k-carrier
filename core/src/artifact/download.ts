/**
 * L0 download + INTEGRITY only, with RESUME
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

export interface DownloadOptions {
  /**
   * Byte progress. `downloaded` counts bytes ON DISK including any resumed
   * prefix, so a resumed download never appears to restart at zero.
   */
  onProgress?: (downloaded: number, total: number) => void;
  clock?: Clock;
  /** Abort the download after this many ms (0 = no timeout). Default 10000. */
  timeoutMs?: number;
  /**
   * Abort after this many ms with NO bytes arriving (0 = off). Default 0.
   *
   * Distinct from `timeoutMs`, and for large artifacts the more useful of the
   * two: a total budget must either be big enough for the slowest acceptable
   * download of a 150MB binary -- in which case a wedged connection holds for
   * just as long -- or small enough to kill a slow one that was making steady
   * progress. Bounding SILENCE instead follows liveness, so the limit does not
   * have to encode a guess about size or bandwidth.
   */
  stallTimeoutMs?: number;
  /**
   * HTTP client for the artifact bytes. `staticManifestSource` already takes
   * one; without the same seam here an adopter can point K at their own server
   * for the MANIFEST but not for the BYTES, which is half a seam and surprising
   * in exactly the place it matters (proxies, custom agents, and an adopter's
   * own integration tests all need both).
   */
  fetchImpl?: typeof fetch;
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

  const bytes = await fetchAndAppend(
    url, partialPath, partialSize, clock, timeoutMs, opts.onProgress, release.size,
    opts.stallTimeoutMs ?? 0, opts.fetchImpl ?? fetch,
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
  stallTimeoutMs = 0,
  doFetch: typeof fetch = fetch,
): Promise<Uint8Array> {
  const controller = new AbortController();
  // Rearmed on every chunk; fires only if the gap between chunks exceeds the
  // budget. `stalled` records WHY we aborted, because the abort itself cannot
  // say -- a stall and a total-timeout abort look identical at the signal.
  let stalled = false;
  let stallTimer: (() => void) | undefined;
  // Set by the race below; invoked when either deadline fires so the pending
  // fetch cannot outlive its own timeout.
  let aborted: (() => void) | undefined;
  const abortReason = (u: string): string =>
    stalled
      ? `download stalled: nothing received for ${stallTimeoutMs}ms (awaiting response): ${u}`
      : `download timed out after ${timeoutMs}ms: ${u}`;
  // Declared AFTER `aborted`: an immediate/virtual clock fires this callback
  // synchronously inside `clock.after`, so a timer created earlier would reach
  // `aborted` in its temporal dead zone. Real clocks hide that ordering; the
  // test clock does not.
  const cancel =
    timeoutMs > 0
      ? clock.after(timeoutMs, () => {
          controller.abort();
          aborted?.();
        })
      : undefined;
  const armStall = (): void => {
    if (stallTimeoutMs <= 0) return;
    stallTimer?.();
    stallTimer = clock.after(stallTimeoutMs, () => {
      stalled = true;
      controller.abort();
      aborted?.();
    });
  };
  try {
    const headers: Record<string, string> = {};
    if (partialSize > 0) headers["Range"] = `bytes=${partialSize}-`;
    let res: Response;
    armStall(); // the response headers themselves must not hang forever
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
        stalled
          ? `download stalled: nothing received for ${stallTimeoutMs}ms (awaiting response): ${url}`
          : timedOut
            ? `download timed out after ${timeoutMs}ms: ${url}`
            : `fetch failed: ${url}`,
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
    armStall();

    if (partialPath === null) {
      // Stream even with nowhere to resume to. `res.arrayBuffer()` is one
      // opaque await: no chunk boundaries, so neither the stall timer nor the
      // progress sink can observe anything -- a download without a resumeDir
      // silently had no byte progress and no stall detection at all, while
      // both looked configured.
      try {
        return await collectStream(url, res.body, total, onProgress, armStall);
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
      if (res.body) {
        // Count from the resumed prefix, never from zero: a bar that restarts
        // reads as "it lost my download" to the person watching it.
        let onDisk = partialSize;
        onProgress?.(onDisk, total ?? 0);
        armStall();
        await streamToFile(res.body, fh, (chunk) => {
          onDisk += chunk;
          armStall();
          onProgress?.(onDisk, total ?? 0);
        });
      }
      await fh.sync();
    } catch (err) {
      // interrupted (abort / connection drop): the prefix stays in the
      // partial for the next attempt
      const timedOut = controller.signal.aborted;
      throw new ArtifactError(
        "DOWNLOAD_FAILED",
        stalled
          ? `download stalled: nothing received for ${stallTimeoutMs}ms (mid-body): ${url}`
          : timedOut
            ? `download timed out after ${timeoutMs}ms: ${url}`
            : `download interrupted: ${url}`,
        { cause: err },
      );
    } finally {
      await fh.close();
    }
    return new Uint8Array(await fs.readFile(partialPath));
  } finally {
    cancel?.();
    stallTimer?.();
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
