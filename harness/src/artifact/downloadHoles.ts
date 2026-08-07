/**
 * M1 download-hole acceptance checks — archer's 8 fixes (486f299..3626b76),
 * one tooth per hole. He wrote the unit tests; these are the RED-able
 * acceptance surfaces: the same assertions as teeth, so the next regression
 * is a red in the gate, not a silent unit-test removal.
 *
 * Holes: ① deadline raced not signalled; ② Rosetta arch lie; ③ progress
 * absent without resumeDir; ④ empty body named as a read failure; ⑤ stall
 * bounds silence (reset on activity); ⑥ in-memory errors classified;
 * ⑦ stall phase named honestly; ⑧ stall timeout exists (⑤'s wedged case).
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { type ToothContext } from "../teeth/registry.ts";
import { downloadVerified } from "../../../core/src/artifact/download.ts";
import { platformKeyFor } from "../../../core/src/platform/posix.ts";
import type { Release } from "../../../core/src/artifact/source.ts";
import {
  signalOnlyDownload,
  naivePlatformKey,
  probeEverywherePlatformKey,
  arrayBufferDownload,
  emptyPrefixDownload,
  totalTimeoutDownload,
  noStallDownload,
  wrongPhaseDownload,
} from "./downloadHolesMutations.ts";

const BODY = new Uint8Array(4096).fill(7);

function releaseFor(url: string): Release {
  return { version: "1.0.0", url, sha256: createHash("sha256").update(BODY).digest("hex"), size: BODY.length };
}

/** A server that writes `chunks` pieces, waiting `gapMs` between each;
 * `stallAfterFirst` sends headers + one chunk, then silence. */
async function serve(chunks: number, gapMs: number, hang = false, stallAfterFirst = false) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": String(BODY.length) });
    if (hang) return; // headers sent, bytes never follow
    const size = Math.ceil(BODY.length / chunks);
    let sent = 0;
    const push = (): void => {
      if (sent >= BODY.length) {
        res.end();
        return;
      }
      res.write(Buffer.from(BODY.subarray(sent, sent + size)));
      sent += size;
      if (stallAfterFirst && sent >= size) return; // headers + one chunk, then silence
      setTimeout(push, gapMs);
    };
    push();
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/app.bin`, close: () => server.close() };
}

/** A 204 response: ok but with NO readable body. */
async function serveNoBody() {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", r);
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/app.bin`, close: () => server.close() };
}

const neverSettles = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// ① m1.download-timeout-enforced
// ---------------------------------------------------------------------------

export async function checkDownloadTimeoutEnforced(
  ctx: ToothContext,
  opts: { signalOnly?: boolean } = {},
): Promise<void> {
  const url = "http://127.0.0.1:1/app.bin"; // nothing listens; the fetch impl decides
  if (opts.signalOnly) {
    // mutation: the deadline is only signalled — a fetch that ignores the
    // signal hangs forever. The bounded race lets the check fail instead of
    // hanging the suite: the bound fires with a DIFFERENT message, so the
    // /timed out after 150ms/ expectation does not match.
    const bound = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("bound")), 500);
    });
    await assert.rejects(
      Promise.race([signalOnlyDownload(releaseFor(url), { timeoutMs: 150, fetchImpl: neverSettles }), bound]),
      /timed out after 150ms/,
      "the deadline must be enforced even when the fetch ignores the signal (signalOnly => RED)",
    );
    return;
  }
  await assert.rejects(
    downloadVerified(releaseFor(url), { fetchImpl: neverSettles, timeoutMs: 150, stallTimeoutMs: 0 }),
    /timed out after 150ms/,
    "an uncooperative fetch must not be able to outlive the deadline",
  );
}

// ---------------------------------------------------------------------------
// ② m1.platform-key-native-arch
// ---------------------------------------------------------------------------

const yes = (): boolean => true;
const no = (): boolean => false;

export async function checkPlatformKeyNativeArch(
  ctx: ToothContext,
  opts: { naiveKey?: boolean; probeEverywhere?: boolean } = {},
): Promise<void> {
  const key = opts.naiveKey
    ? naivePlatformKey
    : opts.probeEverywhere
      ? probeEverywherePlatformKey
      : platformKeyFor;

  assert.equal(key("linux", "x64", no), "linux-x64", "ordinary machines report platform-arch unchanged");
  assert.equal(key("darwin", "arm64", yes), "darwin-arm64", "native arm64 reports arm64");
  assert.equal(
    key("darwin", "x64", yes),
    "darwin-arm64",
    "x64 Node on arm64 hardware must select the arm64 target — Rosetta lies about the machine (naiveKey => RED)",
  );
  assert.equal(
    key("darwin", "x64", no),
    "darwin-x64",
    "a genuine Intel Mac still gets x64 — the hardware probe separates the two",
  );
  const calls: string[] = [];
  const probe = (): boolean => {
    calls.push("called");
    return true;
  };
  key("linux", "x64", probe);
  key("darwin", "arm64", probe);
  key("win32", "x64", probe);
  assert.deepEqual(
    calls,
    [],
    "the hardware probe is consulted ONLY on darwin+x64 — it must not shell out on every platform lookup (probeEverywhere => RED)",
  );
}

// ---------------------------------------------------------------------------
// ③ m1.download-progress-without-resumedir
// ---------------------------------------------------------------------------

export async function checkDownloadProgressWithoutResumeDir(
  ctx: ToothContext,
  opts: { noProgress?: boolean } = {},
): Promise<void> {
  const s = await serve(4, 10);
  try {
    const seen: number[] = [];
    const download = opts.noProgress ? arrayBufferDownload : downloadVerified;
    await download(releaseFor(s.url), {
      timeoutMs: 0,
      onProgress: (downloaded) => seen.push(downloaded),
    });
    assert.ok(
      seen.length > 1,
      `expected progress readings with no resumeDir, got ${seen.length} — the bar must move (noProgress => RED)`,
    );
    assert.equal(seen.at(-1), BODY.length, "the last reading must be the full size");
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i]! >= seen[i - 1]!, "progress must be monotonic");
    }
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------------------
// ④ m1.download-empty-body-named
// ---------------------------------------------------------------------------

export async function checkDownloadEmptyBodyNamed(
  ctx: ToothContext,
  opts: { returnEmptyBytes?: boolean; treatEmptyAsPrefix?: boolean } = {},
): Promise<void> {
  const s = await serveNoBody();
  try {
    // arm 1: the in-memory path (no resumeDir)
    const download = opts.returnEmptyBytes ? arrayBufferDownload : downloadVerified;
    await assert.rejects(
      download(releaseFor(s.url), { timeoutMs: 0 }),
      /no readable body/,
      "a response with no readable body is a failure to READ, not an empty download — the error must name the cause, never a sha256 mismatch (returnEmptyBytes => RED)",
    );
    // arm 2: the RESUME path must name it too — a no-body response is never
    // an empty prefix to continue from. This arm was added after archer
    // proved the first arm does not bite on the resume path.
    const resumeDownload = opts.treatEmptyAsPrefix ? emptyPrefixDownload : downloadVerified;
    await assert.rejects(
      resumeDownload(releaseFor(s.url), { timeoutMs: 0, resumeDir: path.join(ctx.sandboxDir, "resume") }),
      /no readable body/,
      "the resume path must name a no-body response as a read failure, never treat it as an empty prefix (treatEmptyAsPrefix => RED)",
    );
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------------------
// ⑤ m1.download-stall-bounds-silence (+⑧ the stall timeout exists)
// ---------------------------------------------------------------------------

export async function checkDownloadStallBoundsSilence(
  ctx: ToothContext,
  opts: { totalTimeout?: boolean; noStall?: boolean } = {},
): Promise<void> {
  // (a) a download that keeps making progress survives a stall budget
  // shorter than its total time (8 chunks x 40ms ≈ 320ms > 150ms budget).
  const slow = await serve(8, 40);
  try {
    const download = opts.totalTimeout ? totalTimeoutDownload : downloadVerified;
    let completed = false;
    try {
      const bytes = await download(releaseFor(slow.url), { stallTimeoutMs: 150, timeoutMs: 0 });
      completed = bytes.length === BODY.length;
    } catch {
      completed = false;
    }
    assert.ok(
      completed,
      "a slow-but-progressing download must survive a stall budget shorter than its total time — silence is bounded, not total duration (totalTimeout => RED)",
    );
  } finally {
    slow.close();
  }

  // (b) a wedged download (headers, then silence) dies on the stall budget
  // and names the stall. The finite total timeout is a backstop so a missing
  // stall timer produces the total-timeout wording instead of a hang.
  const wedged = await serve(1, 0, true);
  try {
    const download = opts.noStall ? noStallDownload : downloadVerified;
    await assert.rejects(
      download(releaseFor(wedged.url), { stallTimeoutMs: 200, timeoutMs: 3_000 }),
      /stalled: nothing received for 200ms/,
      "a wedged download must die on the STALL budget, not the total budget (noStall => RED)",
    );
  } finally {
    wedged.close();
  }
}

// ---------------------------------------------------------------------------
// ⑥ m1.download-errors-classified
// ---------------------------------------------------------------------------

export async function checkDownloadErrorsClassified(
  ctx: ToothContext,
  opts: { unclassified?: boolean } = {},
): Promise<void> {
  const wedged = await serve(1, 0, true);
  try {
    // in-memory path (no resumeDir): a stall we caused must come back as a
    // typed DOWNLOAD_FAILED naming the reason, never an anonymous stream error.
    const download = opts.unclassified ? arrayBufferDownload : downloadVerified;
    await assert.rejects(
      download(releaseFor(wedged.url), { stallTimeoutMs: 200, timeoutMs: 3_000 }),
      /stalled|timed out/,
      "a stall the downloader itself caused must be reported as the stall, not as an anonymous transport failure (unclassified => RED)",
    );
  } finally {
    wedged.close();
  }
}

// ---------------------------------------------------------------------------
// ⑦ m1.download-stall-phase-honest
// ---------------------------------------------------------------------------

export async function checkDownloadStallPhaseHonest(
  ctx: ToothContext,
  opts: { wrongPhase?: boolean } = {},
): Promise<void> {
  const mid = await serve(2, 0, false, true); // headers + one chunk, then silence
  try {
    const download = opts.wrongPhase ? wrongPhaseDownload : downloadVerified;
    await assert.rejects(
      download(releaseFor(mid.url), { stallTimeoutMs: 200, timeoutMs: 3_000 }),
      /\(mid-body\)/,
      "a stall that happened mid-body must say mid-body, not 'awaiting response' (wrongPhase => RED)",
    );
  } finally {
    mid.close();
  }
}
