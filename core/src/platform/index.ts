import type { PlatformOps } from "./ops.ts";
import { posixOps } from "./posix.ts";
import { windowsOps } from "./windows.ts";

/** Pick the seam implementation for the host we are running on. */
export function platformOpsFor(platform: NodeJS.Platform = process.platform): PlatformOps {
  return platform === "win32" ? windowsOps : posixOps;
}

export type { PlatformOps } from "./ops.ts";
export { PlatformUnsupportedError } from "./ops.ts";
