/**
 * Where an interrupted download parks its prefix.
 *
 * Its own module for the line budget, but the naming rule genuinely belongs in
 * one place: resume works only if the NEXT attempt derives the same path from
 * the same URL, so two copies of this rule that drift produce a resume that
 * silently restarts from zero.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function partialPathFor(resumeDir: string, url: string): string {
  return path.join(resumeDir, `${sha256Hex(new TextEncoder().encode(url))}.part`);
}
