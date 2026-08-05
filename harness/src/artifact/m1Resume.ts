/**
 * m1.download-resumes-after-kill (断点续传): a process that dies
 * mid-download must not restart from zero. The partial prefix survives, the
 * next attempt resumes via a Range request, and the FULL assembled bytes
 * verify. Real kill, real resume, real server.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { type ToothContext } from "../teeth/registry.ts";
import { currentPlatformKey, parseManifest } from "../../../core/src/artifact/staticManifestSource.ts";
import { downloadVerified, partialPathFor } from "../../../core/src/artifact/download.ts";
import { FakeServer } from "../fake-server/server.ts";
import { MANIFEST_FILE, sha256Hex } from "../fake-server/manifest.ts";
import { coreUpgraderUrl } from "./m1.ts";

// ---------------------------------------------------------------------------
// m1.download-resumes-after-kill (断点续传)
// ---------------------------------------------------------------------------

/**
 * A process that dies mid-download must not restart from zero: the partial
 * prefix survives, the next attempt resumes via a Range request, and the
 * FULL assembled bytes verify. Real kill, real resume, real server.
 */
export async function checkDownloadResumesAfterKill(
  ctx: ToothContext,
  opts: { skipResume?: boolean } = {},
): Promise<void> {
  const platform = currentPlatformKey();
  const server = new FakeServer({
    storeDir: path.join(ctx.sandboxDir, "store"),
    // slow enough that a kill lands mid-download deterministically
    throttle: { bytesPerTick: 4096, tickMs: 5 },
  });
  await server.start();
  try {
    // a real-ish sized artifact (2MB) so the kill window is comfortable;
    // published via the store directly (the factory stamps the tiny demo)
    const big = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await server.store.publish({
      version: "1.0.0",
      artifacts: { "big-1.0.0.bin": big },
      platform,
    });
    const manifest = parseManifest(
      new TextDecoder().decode(await server.store.readFile(MANIFEST_FILE)),
    );
    const target = manifest.targets[platform];
    assert.ok(target);
    const url = `${server.url}/${target.file}`;
    const release = {
      version: "1.0.0",
      url,
      sha256: target.sha256,
      size: target.size,
    };

    const resumeDir = path.join(ctx.sandboxDir, "incoming");
    const coreUrl = coreUpgraderUrl();
    const coreSrc = new URL(".", coreUrl).href;
    const dlScript = [
      `const { downloadVerified, partialPathFor } = await import(${JSON.stringify(new URL("artifact/download.ts", coreSrc).href)});`,
      `const { promises: fs } = await import("node:fs");`,
      `const url = ${JSON.stringify(url)};`,
      `const dir = ${JSON.stringify(resumeDir)};`,
      `const release = ${JSON.stringify(release)};`,
      `const bytes = await downloadVerified(release, { resumeDir: dir, timeoutMs: 60000 });`,
      `await fs.writeFile(process.env.K_DL_OUT, bytes);`,
      `process.exit(0);`,
    ].join("\n");

    // First downloader: kill it mid-download (after the partial has bytes).
    const child = spawn(process.execPath, ["--input-type=module", "-e", dlScript], {
      env: { ...process.env, K_DL_OUT: path.join(ctx.sandboxDir, "first.bin") },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let childErr = "";
    child.stderr.on("data", (d: Buffer) => {
      childErr += String(d);
    });
    const partialPath = partialPathFor(resumeDir, url);
    await waitForFileGrow(partialPath, 1024 * 1024, 20000).catch((err) => {
      throw new Error(`${(err as Error).message} (child stderr: ${childErr.trim()})`);
    });
    child.kill("SIGKILL");
    await waitForExit(child);
    const partialSize = (await fs.stat(partialPath)).size;
    assert.ok(partialSize > 0 && partialSize < release.size, "the kill must land mid-download");

    if (opts.skipResume) {
      // mutation: a FRESH resumeDir — no partial, so no Range request; the
      // resume assertion must go RED
      const freshDir = path.join(ctx.sandboxDir, "incoming-fresh");
      const bytes = await downloadVerified(release, { resumeDir: freshDir, timeoutMs: 60000 });
      assert.equal(bytes.length, release.size);
      assert.ok(
        server.requestLog.some((r) => r.url === target.file && r.range !== null),
        "the resume must issue a Range request (skipResume mutation => RED)",
      );
      return;
    }

    // Second downloader (in-process): resumes from the partial via Range.
    const before = server.requestLog.length;
    const bytes = await downloadVerified(release, { resumeDir, timeoutMs: 60000 });
    assert.equal(bytes.length, release.size, "the resumed download must assemble the FULL bytes");
    assert.equal(sha256Hex(bytes), release.sha256, "the assembled bytes must verify");
    const rangeReq = server.requestLog.slice(before).find((r) => r.url === target.file && r.range !== null);
    assert.ok(rangeReq, "the resume must issue a Range request");
    assert.equal(rangeReq!.range, `bytes=${partialSize}-`, "the Range must start at the partial size");
  } finally {
    await server.stop();
  }
}

async function waitForFileGrow(p: string, minBytes: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const size = (await fs.stat(p)).size;
      if (size >= minBytes) return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`file ${p} never grew to ${minBytes} bytes`);
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

