/**
 * Black-box target — code-defined command declarations (harness-design
 * §1.76 ②; final ruling: NO zero-config defaults, NO
 * convention probing).
 *
 * `k.target.ts` (or `--target <path>`) MUST exist next to the binary,
 * default-exporting a BlackBoxTarget with ALL command names explicitly
 * declared. Missing = an immediate typed FAIL (BLACKBOX_TARGET_REQUIRED)
 * that tells the adopter what to declare — the harness never guesses
 * (`--version` / `self upgrade` are not implied).
 *
 * A wrong shape is a COMPILE-TIME error on the adopter's side via
 * `satisfies BlackBoxTarget`; the harness also validates at load because
 * a target that skips `satisfies` is only catchable at runtime (reported
 * to the author).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export interface BlackBoxTarget {
  /** Declared version command args. REQUIRED — no implicit default. */
  version: string[];
  /** Declared self-upgrade command args. REQUIRED — no implicit default. */
  selfUpgrade: string[];
  /** Declared status command args (daemon/managed contract). Optional. */
  status?: string[];
  /** Extra env for the commands (the adopter's config surface). */
  env?: Record<string, string>;
}

export const TARGET_FILE = "k.target.ts";

export interface LoadedTarget {
  target: BlackBoxTarget;
  /** Absolute path of the loaded target file. */
  path: string;
}

export async function loadTarget(opts: {
  binDir: string;
  /** Explicit --target <path>; defaults to <binDir>/k.target.ts. */
  explicitPath?: string;
}): Promise<LoadedTarget> {
  const targetPath = opts.explicitPath ?? path.join(opts.binDir, TARGET_FILE);
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(
      opts.explicitPath
        ? `BLACKBOX_TARGET_REQUIRED: --target file not found: ${targetPath}`
        : `BLACKBOX_TARGET_REQUIRED: ${TARGET_FILE} must exist next to the binary (${opts.binDir}) — declare version + selfUpgrade commands explicitly; the harness does not guess`,
    );
  }

  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(targetPath).href)) as { default?: unknown };
  } catch (err) {
    throw new Error(`BLACKBOX_TARGET_INVALID: could not load ${targetPath}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  const declared = mod.default;
  if (typeof declared !== "object" || declared === null) {
    throw new Error(
      `BLACKBOX_TARGET_INVALID: ${targetPath} must default-export an object (BlackBoxTarget); got ${typeof declared} — write "satisfies BlackBoxTarget" to catch this at compile time`,
    );
  }
  const t = declared as BlackBoxTarget;
  if (!isStringArray(t.version) || t.version.length === 0) {
    throw new Error(`BLACKBOX_TARGET_INVALID: ${targetPath} must declare version: string[] (BlackBoxTarget)`);
  }
  if (!isStringArray(t.selfUpgrade) || t.selfUpgrade.length === 0) {
    throw new Error(`BLACKBOX_TARGET_INVALID: ${targetPath} must declare selfUpgrade: string[] (BlackBoxTarget)`);
  }
  if (t.status !== undefined && !isStringArray(t.status)) {
    throw new Error(`BLACKBOX_TARGET_INVALID: ${targetPath} status must be string[] (BlackBoxTarget)`);
  }
  return { target: t, path: targetPath };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
