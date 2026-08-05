/**
 * k.json — the app-declared black-box CLI contract (§1.76 ②): the app
 * declares how to call its version/status/selfUpgrade commands; the
 * harness reads this (defaults: `--version` / `self upgrade`) and drives
 * the binary through it. Missing file = defaults; malformed = typed FAIL.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export const DEFAULT_VERSION_ARGS = ["--version"] as const;
export const DEFAULT_SELF_UPGRADE_ARGS = ["self", "upgrade"] as const;

/** §1.76 ② — app-declared command names. All fields optional. */
export interface KJson {
  version?: string[];
  status?: string[];
  selfUpgrade?: string[];
}

export function defaultKJson(): KJson {
  return {
    version: [...DEFAULT_VERSION_ARGS],
    selfUpgrade: [...DEFAULT_SELF_UPGRADE_ARGS],
  };
}

export async function loadKJson(binDir: string): Promise<KJson> {
  const p = path.join(binDir, "k.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: KJson = defaultKJson();
    for (const key of ["version", "status", "selfUpgrade"] as const) {
      const v = parsed[key];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) {
        throw new Error(`CONTRACT_KJSON_MALFORMED: k.json "${key}" must be an array of strings`);
      }
      out[key] = v as string[];
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultKJson();
    throw err;
  }
}
