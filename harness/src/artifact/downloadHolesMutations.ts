/**
 * M1 download-hole mutation downloads/key-builders — the wrong behaviors
 * each tooth's negative control must catch (archer's 8 fixes, one tooth
 * per hole). Each stub is the OLD implementation the fix replaced, so a
 * tooth going green on the real core and red under the stub proves the
 * assertion has teeth. Kept separate from downloadHoles.ts for the budget.
 */
import { createHash } from "node:crypto";
import { ArtifactError } from "../../../core/src/artifact/errors.ts";
import type { Release } from "../../../core/src/artifact/source.ts";
import { type Clock, systemClock } from "../../../core/src/clock.ts";

export interface StubDownloadOpts {
  clock?: Clock;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (downloaded: number, total: number) => void;
}

/** Mutation ①: the deadline is only SIGNALLED, never raced — a fetch that
 * ignores AbortSignal outlives every timeout. */
export async function signalOnlyDownload(release: Release, opts: StubDownloadOpts = {}): Promise<Uint8Array> {
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const controller = new AbortController();
  const cancel = timeoutMs > 0 ? clock.after(timeoutMs, () => controller.abort()) : undefined;
  try {
    const res = await (opts.fetchImpl ?? fetch)(release.url, { signal: controller.signal });
    if (!res.ok) throw new ArtifactError("DOWNLOAD_FAILED", `GET ${release.url} -> HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    cancel?.();
  }
}

/** Mutation ②: naive `${platform}-${arch}` — under Rosetta the process arch
 * lies about the hardware, so the machine is pinned to the wrong target. */
export function naivePlatformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** Mutation ②: the hardware probe is consulted on EVERY platform lookup,
 * not just darwin+x64. */
export function probeEverywherePlatformKey(platform: string, arch: string, probe: () => boolean): string {
  return `${platform}-${probe() ? "arm64" : arch}`;
}

/** Mutation ③④⑥: one opaque `arrayBuffer()` await — no chunk boundaries,
 * so no progress, no stall detection, no error classification. The total
 * timeout is SIGNALLED (the pre-fix behavior): an abort on a wedged server
 * comes back as a bare AbortError, never a classified DOWNLOAD_FAILED. */
export async function arrayBufferDownload(release: Release, opts: StubDownloadOpts = {}): Promise<Uint8Array> {
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const controller = new AbortController();
  const cancel = timeoutMs > 0 ? clock.after(timeoutMs, () => controller.abort()) : undefined;
  try {
    const res = await (opts.fetchImpl ?? fetch)(release.url, { signal: controller.signal });
    if (!res.ok) throw new ArtifactError("DOWNLOAD_FAILED", `GET ${release.url} -> HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    cancel?.();
  }
}

async function streamRaw(
  release: Release,
  opts: StubDownloadOpts,
  armOnce: (clock: Clock, fire: () => void) => void,
): Promise<Uint8Array> {
  const clock = opts.clock ?? systemClock;
  const timeoutMs = opts.timeoutMs ?? 0;
  const controller = new AbortController();
  let fired = false;
  const fire = (): void => {
    fired = true;
    controller.abort();
  };
  if (timeoutMs > 0) clock.after(timeoutMs, fire);
  armOnce(clock, fire);
  const res = await (opts.fetchImpl ?? fetch)(release.url, { signal: controller.signal });
  if (!res.ok) throw new ArtifactError("DOWNLOAD_FAILED", `GET ${release.url} -> HTTP ${res.status}`);
  if (!res.body) throw new ArtifactError("DOWNLOAD_FAILED", `response has no readable body: ${release.url}`);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      parts.push(value);
      got += value.byteLength;
      opts.onProgress?.(got, release.size);
    }
  } catch (err) {
    if (fired) throw new ArtifactError("DOWNLOAD_FAILED", `download timed out: ${release.url}`, { cause: err });
    throw err;
  }
  const all = new Uint8Array(got);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return all;
}

/** Mutation ⑤a: the stall budget is armed ONCE — a total timeout that kills
 * a slow-but-progressing download. */
export async function totalTimeoutDownload(release: Release, opts: StubDownloadOpts = {}): Promise<Uint8Array> {
  return streamRaw(release, opts, (clock, fire) => {
    const budget = (opts.stallTimeoutMs ?? 0) > 0 ? opts.stallTimeoutMs! : opts.timeoutMs ?? 0;
    if (budget > 0) clock.after(budget, fire);
  });
}

/** Mutation ⑤b: no stall budget at all — a wedged connection holds for the
 * total timeout and the failure never names the stall. */
export async function noStallDownload(release: Release, opts: StubDownloadOpts = {}): Promise<Uint8Array> {
  return streamRaw(release, opts, () => {});
}

/** Mutation ⑦: the stall error always says "awaiting response", even for a
 * stall that happened mid-body — the reader looks at the wrong end. */
export async function wrongPhaseDownload(release: Release, opts: StubDownloadOpts = {}): Promise<Uint8Array> {
  const clock = opts.clock ?? systemClock;
  const stall = opts.stallTimeoutMs ?? 0;
  const controller = new AbortController();
  let fired = false;
  const fire = (): void => {
    fired = true;
    controller.abort();
  };
  if (stall > 0) clock.after(stall, fire);
  const res = await (opts.fetchImpl ?? fetch)(release.url, { signal: controller.signal });
  if (!res.ok) throw new ArtifactError("DOWNLOAD_FAILED", `GET ${release.url} -> HTTP ${res.status}`);
  if (!res.body) throw new ArtifactError("DOWNLOAD_FAILED", `response has no readable body: ${release.url}`);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (err) {
    if (fired) {
      throw new ArtifactError(
        "DOWNLOAD_FAILED",
        `download stalled: nothing received for ${stall}ms (awaiting response): ${release.url}`,
        { cause: err },
      );
    }
    throw err;
  }
  return new Uint8Array(0);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
