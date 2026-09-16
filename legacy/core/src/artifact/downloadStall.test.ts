// @invariant — a stall timeout bounds SILENCE, not total duration. The whole
// point is that a slow-but-progressing download survives while a wedged one
// dies; a test that only proves "wedged dies" would pass for a plain total
// timeout and prove nothing about the feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { downloadVerified } from "./download.ts";
import { createHash } from "node:crypto";

const BODY = new Uint8Array(4096).fill(7);

/** A server that writes `chunks` pieces, waiting `gapMs` between each. */
async function serve(chunks: number, gapMs: number, hang = false) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": String(BODY.length) });
    if (hang) {
      res.flushHeaders();
      return; // headers sent, bytes never follow
    }
    const size = Math.ceil(BODY.length / chunks);
    let sent = 0;
    const push = (): void => {
      if (sent >= BODY.length) { res.end(); return; }
      res.write(Buffer.from(BODY.subarray(sent, sent + size)));
      sent += size;
      setTimeout(push, gapMs);
    };
    push();
  });
  await new Promise<void>((r) => { server.listen(0, "127.0.0.1", r); });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/app.bin`, close: () => { server.close(); } };
}

const release = (url: string) => ({
  version: "1.0.0", url, sha256: createHash("sha256").update(BODY).digest("hex"), size: BODY.length,
});

test("a download that keeps making progress survives a stall timeout shorter than its total time", async () => {
  // 8 chunks x 40ms = ~320ms total, far longer than the 150ms stall budget.
  // A total-duration timeout of 150ms would kill this; a stall timeout must not.
  const s = await serve(8, 40);
  try {
    const bytes = await downloadVerified(release(s.url), { stallTimeoutMs: 150, timeoutMs: 0 });
    assert.equal(bytes.length, BODY.length, "the slow download must complete");
  } finally {
    s.close();
  }
});

test("a wedged download dies on the stall budget, and says so", async () => {
  const s = await serve(1, 0, true); // headers, then silence
  try {
    await assert.rejects(
      // A finite total timeout well above the stall budget is deliberate: with
      // the stall timer disabled this test would otherwise HANG rather than
      // fail, and a hang is a worse signal than a red — it reads as
      // infrastructure trouble, not as a broken guarantee. With the backstop,
      // removing the stall timer produces the total-timeout wording instead
      // and the assertion below fails cleanly. It also proves the stall fires
      // FIRST, which is the whole feature.
      downloadVerified(release(s.url), { stallTimeoutMs: 200, timeoutMs: 3_000 }),
      /stalled: nothing received for 200ms/,
      "the failure must name the stall, not a generic interruption — and one wording " +
      "for both phases, so a caller never has to know which await was pending",
    );
  } finally {
    s.close();
  }
});

test("response headers have a budget distinct from body-idle liveness", async () => {
  const neverSettles = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  await assert.rejects(
    downloadVerified(release("http://127.0.0.1:1/app.bin"), {
      fetchImpl: neverSettles,
      responseTimeoutMs: 120,
      idleTimeoutMs: 900,
      timeoutMs: 3_000,
    }),
    /response timed out after 120ms \(awaiting response\)/u,
    "an unreachable server must spend the response budget, not the body-idle or total budget",
  );
});

test("stallTimeoutMs is off by default (a slow download is not a failure)", async () => {
  const s = await serve(4, 60);
  try {
    const bytes = await downloadVerified(release(s.url), { timeoutMs: 0 });
    assert.equal(bytes.length, BODY.length);
  } finally {
    s.close();
  }
});

test("byte progress is reported even with no resumeDir", async () => {
  // Before the streaming rewrite this path was one `res.arrayBuffer()` await,
  // so a caller who passed onProgress but no resumeDir got a configured-looking
  // sink that never fired once. Nothing failed; the bar just never moved.
  const s = await serve(4, 10);
  try {
    const seen: number[] = [];
    await downloadVerified(release(s.url), {
      timeoutMs: 0,
      onProgress: (downloaded) => seen.push(downloaded),
    });
    assert.ok(seen.length > 1, `expected progress readings, got ${seen.length}`);
    assert.equal(seen.at(-1), BODY.length, "the last reading must be the full size");
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i]! >= seen[i - 1]!, "progress must be monotonic");
    }
  } finally {
    s.close();
  }
});

test("a fetch that IGNORES the abort signal still hits the deadline", async () => {
  // fetchImpl is an adopter-supplied seam. A client that never settles and
  // ignores AbortSignal would, if the deadline were only signalled, leave every
  // timeout inert — and an inert timeout is indistinguishable from a download
  // that is merely still working. The promise must be raced, not just aborted.
  const neverSettles = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  await assert.rejects(
    downloadVerified(release("http://127.0.0.1:1/app.bin"), {
      fetchImpl: neverSettles,
      timeoutMs: 150,
      stallTimeoutMs: 0,
    }),
    /timed out after 150ms/,
    "an uncooperative fetch must not be able to outlive the deadline",
  );
});
