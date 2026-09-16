/**
 * Read a response body into memory while keeping chunk boundaries visible.
 *
 * Split out of download.ts for the line budget. The boundaries are the point:
 * `res.arrayBuffer()` is one opaque await, so neither a stall timer nor a
 * progress sink can observe anything through it.
 */
import { ArtifactError } from "./errors.ts";

export async function collectStream(
  url: string,
  body: ReadableStream<Uint8Array> | null,
  total: number | undefined,
  onProgress: ((downloaded: number, total: number) => void) | undefined,
  onChunk: () => void,
): Promise<Uint8Array> {
  // A response with no readable body is a failure to READ, not an empty
  // download. Returning zero bytes here would hand the caller a valid-looking
  // empty artifact whose only symptom is a sha256 mismatch against the digest
  // of the empty string -- an error that describes the consequence and hides
  // the cause. Same rule as everywhere else: the failure path must not produce
  // the empty success value.
  if (!body) {
    throw new ArtifactError("DOWNLOAD_FAILED", `response has no readable body: ${url}`);
  }
  const parts: Uint8Array[] = [];
  let got = 0;
  onProgress?.(0, total ?? 0);
  const reader = body.getReader();
  {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      parts.push(value);
      got += value.byteLength;
      onChunk();
      onProgress?.(got, total ?? 0);
    }
  }
  const all = new Uint8Array(got);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return all;
}

