import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { ArtifactError } from "./errors.ts";
import type { Release } from "./source.ts";

/** Decode only verified transport bytes; bound expansion by the canonical size. */
export async function decodeGzipArtifact(bytes: Uint8Array, release: Release): Promise<Uint8Array> {
  let decoded: Uint8Array;
  try {
    decoded = await new Promise<Buffer>((resolve, reject) => {
      gunzip(bytes, { maxOutputLength: Math.max(1, release.size) }, (error, output) => {
        if (error) reject(error);
        else resolve(output);
      });
    });
  } catch (cause) {
    throw new ArtifactError("DOWNLOAD_FAILED", "gzip is invalid or exceeds the declared decoded size", { cause });
  }
  if (decoded.length !== release.size) {
    throw new ArtifactError("SIZE_MISMATCH", "decoded gzip size does not match the release");
  }
  if (createHash("sha256").update(decoded).digest("hex") !== release.sha256) {
    throw new ArtifactError("SHA256_MISMATCH", "decoded gzip SHA-256 does not match the release");
  }
  return decoded;
}
