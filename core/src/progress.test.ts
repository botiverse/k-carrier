// @invariant — progress must be observational: it reports what happened and
// can never change what happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUpgrader } from "./createUpgrader.ts";
import { staticManifestSource } from "./artifact/staticManifestSource.ts";
import { stageForPhase, type UpgradeProgress } from "./progress.ts";
import type { ProcessEvidence } from "./lifecycle/hostAdapter.ts";

const BYTES = new TextEncoder().encode("#!/bin/sh\necho 2.0.0\n".repeat(64));
const PLATFORM = `${process.platform}-${process.arch}`;

async function serve(): Promise<{ baseUrl: string; close: () => void }> {
  const sha = createHash("sha256").update(BYTES).digest("hex");
  const manifest = JSON.stringify({
    version: "2.0.0",
    targets: { [PLATFORM]: { file: "app.bin", sha256: sha, size: BYTES.length } },
  });
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("manifest.json")) { res.writeHead(200); res.end(manifest); return; }
    // Honour Range, or the resume path is never exercised: K discards a
    // partial when the server answers 200, so a server that ignores Range
    // turns a "resume" test into an ordinary download that starts at zero.
    const range = /^bytes=(\d+)-$/u.exec(String(req.headers.range ?? ""));
    if (range) {
      const from = Number(range[1]);
      res.writeHead(206, {
        "Content-Range": `bytes ${from}-${BYTES.length - 1}/${BYTES.length}`,
        "Content-Length": String(BYTES.length - from),
      });
      res.end(Buffer.from(BYTES.subarray(from)));
      return;
    }
    res.writeHead(200); res.end(Buffer.from(BYTES));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/app`, close: () => server.close() };
}

function host() {
  return {
    async quiesce() {}, async stop() {}, async start() {}, async resume() {},
    async healthProbe(): Promise<ProcessEvidence> {
      return { version: "2.0.0", pid: process.pid, startId: "fresh" };
    },
  };
}

test("an upgrade reports its stages in order, ending at a terminal one", async () => {
  const src = await serve();
  const stateDir = await mkdtemp(path.join(tmpdir(), "k-progress-"));
  const seen: UpgradeProgress[] = [];
  try {
    const outcome = await createUpgrader({
      host: host(),
      source: staticManifestSource({ baseUrl: src.baseUrl }),
      policy: "auto",
      notificationSink: async () => {},
      stateDir,
      onProgress: (p) => seen.push(p),
    }).upgrade();
    assert.equal(outcome.result, "promoted");

    const stages = seen.map((p) => p.stage);
    for (const expected of ["checking", "downloading", "verifying", "staging", "handing-over", "promoted"]) {
      assert.ok(stages.includes(expected as never), `missing stage: ${expected}`);
    }
    assert.equal(stages.at(-1), "promoted", "the last thing a host hears must be terminal");
    // Order, not merely presence: a bar that reports staging before downloading
    // is worse than none.
    assert.ok(stages.indexOf("downloading") < stages.indexOf("staging"));
    assert.ok(stages.indexOf("staging") < stages.indexOf("promoted"));
  } finally {
    src.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("byte progress never goes backwards and never exceeds the total", async () => {
  const src = await serve();
  const stateDir = await mkdtemp(path.join(tmpdir(), "k-progress-bytes-"));
  const points: Array<{ downloaded: number; total: number }> = [];
  try {
    await createUpgrader({
      host: host(),
      source: staticManifestSource({ baseUrl: src.baseUrl }),
      policy: "auto",
      notificationSink: async () => {},
      stateDir,
      onProgress: (p) => {
        if (p.stage === "downloading" && p.downloaded !== undefined && p.total !== undefined) {
          points.push({ downloaded: p.downloaded, total: p.total });
        }
      },
    }).upgrade();
    assert.ok(points.length > 0, "a download must report at least one byte reading");
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i]!.downloaded >= points[i - 1]!.downloaded, "progress must be monotonic");
    }
    assert.equal(points.at(-1)!.downloaded, BYTES.length, "the last reading is the whole artifact");
    assert.ok(points.every((p) => p.downloaded <= p.total), "never more than the total");
  } finally {
    src.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("THE POINT: a throwing progress sink cannot fail the upgrade", async () => {
  // Progress exists so a human can tell "slow" from "hung". If a broken bar
  // could abort an upgrade, the observability would have become a new failure
  // mode of the thing it observes.
  const src = await serve();
  const stateDir = await mkdtemp(path.join(tmpdir(), "k-progress-throw-"));
  try {
    const outcome = await createUpgrader({
      host: host(),
      source: staticManifestSource({ baseUrl: src.baseUrl }),
      policy: "auto",
      notificationSink: async () => {},
      stateDir,
      onProgress: () => { throw new Error("the host's progress bar exploded"); },
    }).upgrade();
    assert.equal(outcome.result, "promoted");
  } finally {
    src.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("stages are the transaction's phases, not a parallel vocabulary", () => {
  // If these drift apart, a host shows a state the machine is not in.
  assert.equal(stageForPhase("staged"), "staging");
  assert.equal(stageForPhase("handing-over"), "handing-over");
  assert.equal(stageForPhase("readback"), "probing");
  assert.equal(stageForPhase("promoted"), "promoted");
  assert.equal(stageForPhase("rolled-back"), "rolled-back");
  assert.equal(stageForPhase("idle"), null, "nothing in flight reports nothing");
});

test("THE POINT: a RESUMED download counts from the prefix, not from zero", async () => {
  // The rule this pins exists only for resume, and my first version of this
  // file never exercised a resume — so mutating the counter to start at zero
  // reddened nothing. A rule whose only scenario is untested is decoration.
  const src = await serve();
  const stateDir = await mkdtemp(path.join(tmpdir(), "k-progress-resume-"));
  try {
    // Plant a partial exactly as an interrupted attempt would leave behind.
    const { partialPathFor } = await import("./artifact/download.ts");
    const incoming = path.join(stateDir, "incoming");
    const manifestUrl = `${src.baseUrl}/app.bin`;
    const partial = partialPathFor(incoming, manifestUrl);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(incoming, { recursive: true });
    const prefixLength = Math.floor(BYTES.length / 2);
    await writeFile(partial, Buffer.from(BYTES.subarray(0, prefixLength)));

    const first: number[] = [];
    await createUpgrader({
      host: host(),
      source: staticManifestSource({ baseUrl: src.baseUrl }),
      policy: "auto",
      notificationSink: async () => {},
      stateDir,
      onProgress: (p) => {
        if (p.stage === "downloading" && p.downloaded !== undefined) first.push(p.downloaded);
      },
    }).upgrade();

    assert.ok(first.length > 0, "the resumed download must still report progress");
    assert.ok(
      first[0]! >= prefixLength,
      `the first reading must include the ${prefixLength}-byte prefix already on disk, got ${first[0]}`,
    );
    for (let i = 1; i < first.length; i += 1) {
      assert.ok(first[i]! >= first[i - 1]!, "still monotonic across a resume");
    }
  } finally {
    src.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
