import { createUpgrader, type CreateUpgraderOptions } from "../createUpgrader.ts";
import type { Upgrader } from "../upgrader.ts";

/** Same K engine, external ownership: archive terminal receipts instead of blocking on delivery. */
export function createExternalUpgrader(options: Omit<CreateUpgraderOptions, "terminalReceiptPolicy">): Upgrader {
  return createUpgrader({ ...options, terminalReceiptPolicy: "archive" });
}
