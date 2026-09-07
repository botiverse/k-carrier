import { createUpgrader, type CreateUpgraderOptions } from "../createUpgrader.ts";
import type { Upgrader } from "../upgrader.ts";

/** The sole supported integration constructor: execution belongs to the disposable runner. */
export function createExternalUpgrader(options: CreateUpgraderOptions): Upgrader {
  return createUpgrader(options);
}
