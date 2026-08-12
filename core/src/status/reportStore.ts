/**
 * Report store — the LAST convergence report, persisted across restarts
 * (M6, L5; a machine that DID converge must not report
 * NOT_OBSERVED after a restart, AND an unreadable report must not be
 * reported as "never observed" — the provenance three-state lesson applies
 * here too: "I cannot read it" is not "it never happened").
 *
 * Three states, mechanically distinct:
 *  - genesis: no report file — the machine never promoted. NOT_OBSERVED.
 *  - observed: a valid, version-stamped report from the last promote.
 *  - unreadable: the file exists but cannot be read (EACCES/EISDIR/EIO) or
 *    is corrupt. The machine DID observe something; its record is hidden,
 *    not absent.
 *
 * persistReport is durable BEFORE visible (write tmp, fsync, then rename —
 * same promise as the provenance append): a rename alone guarantees
 * atomic visibility, not that the bytes survived a power cut.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ConvergenceReport } from "../converge/predicates.ts";
import { platformOpsFor } from "../platform/index.ts";

const REPORT_FILE = "report.json";

export type ReportRead =
  | { kind: "genesis" }
  | { kind: "observed"; report: ConvergenceReport }
  | { kind: "unreadable"; reason: string };

export async function persistReport(stateDir: string, report: ConvergenceReport): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, REPORT_FILE);
  const tmp = `${target}.tmp`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(report));
    await fh.sync(); // durable BEFORE the rename makes it visible
  } finally {
    await fh.close();
  }
  await platformOpsFor().renamePath(tmp, target);
}

export async function loadLastReport(stateDir: string): Promise<ReportRead> {
  let text: string;
  try {
    text = await fs.readFile(path.join(stateDir, REPORT_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "genesis" };
    return {
      kind: "unreadable",
      reason: `cannot read ${REPORT_FILE} (${code ?? (err as Error).message}); unreadable is NOT never-observed`,
    };
  }
  try {
    const parsed = JSON.parse(text) as ConvergenceReport;
    if (typeof parsed.version !== "string") throw new Error("report carries no version stamp");
    if (!parsed.binaryAtTarget || typeof parsed.binaryAtTarget.passed !== "boolean") {
      throw new Error("report carries no binaryAtTarget");
    }
    return { kind: "observed", report: parsed };
  } catch (err) {
    return { kind: "unreadable", reason: `corrupt ${REPORT_FILE}: ${(err as Error).message}` };
  }
}
