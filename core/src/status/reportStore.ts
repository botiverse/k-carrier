/**
 * Report store — the LAST convergence report, persisted across restarts
 * (M6, L5; archer's finding: a machine that DID converge must not report
 * NOT_OBSERVED after a daemon restart — "observed, I restarted" is not
 * "never observed").
 *
 * The report is a cache of the last promote's evidence, written atomically
 * (tmp + rename) after each promote and loaded at first use. A report that
 * cannot be read (missing/corrupt) reads as null — fail-safe, never a
 * fabricated pass; the PROVENANCE journal is the durable record of whether
 * reconciliation happened at all, and it keeps its own three-state truth.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ConvergenceReport } from "../converge/predicates.ts";
import { platformOpsFor } from "../platform/index.ts";

const REPORT_FILE = "report.json";

export async function persistReport(stateDir: string, report: ConvergenceReport): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, REPORT_FILE);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(report));
  await platformOpsFor().renamePath(tmp, target);
}

export async function loadLastReport(stateDir: string): Promise<ConvergenceReport | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(stateDir, REPORT_FILE), "utf8");
  } catch {
    return null; // never promoted (or unreadable) — no evidence to report
  }
  try {
    const parsed = JSON.parse(text) as ConvergenceReport;
    if (typeof parsed.version !== "string") return null;
    if (!parsed.binaryAtTarget || typeof parsed.binaryAtTarget.passed !== "boolean") return null;
    return parsed;
  } catch {
    return null; // corrupt: no evidence, and never a fabricated pass
  }
}
