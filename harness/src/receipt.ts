/**
 * Structured receipt — the k-harness output contract (harness-design §1.3:
 * "跑完输出结构化 receipt（给 CI 和人两用）"). Human-readable lines on
 * stdout, full JSON on request (`--json`); exit code = 0 iff result pass.
 */
import type { Profile } from "./teeth/registry.ts";

export type CheckStatus = "pass" | "fail" | "na";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  /** Typed failure (`CODE: message`) or null on pass/na. */
  error: string | null;
  durationMs: number;
}

export type Mode = "profile" | "bin" | "adapter";

export interface Receipt {
  mode: Mode;
  profile: Profile;
  /** The binary/adapter under test, or null for profile mode. */
  target: string | null;
  startedAtMs: number;
  durationMs: number;
  checks: CheckResult[];
  summary: { pass: number; fail: number; na: number; total: number };
  result: "pass" | "fail";
}

export function buildReceipt(opts: {
  mode: Mode;
  profile: Profile;
  target: string | null;
  checks: CheckResult[];
  startedAtMs?: number;
  durationMs?: number;
}): Receipt {
  const pass = opts.checks.filter((c) => c.status === "pass").length;
  const fail = opts.checks.filter((c) => c.status === "fail").length;
  const na = opts.checks.filter((c) => c.status === "na").length;
  // Fail-closed on BOTH shapes of nothing:
  //   - an empty check list ("0 checks" ≠ "all passed"), and
  //   - a list where nothing actually executed. A receipt of all-`na` used to
  //     report pass, which is the empty suite wearing a non-empty list: the
  //     count looks healthy and not one thing was verified.
  // A green therefore requires at least one check that genuinely passed.
  const result: "pass" | "fail" =
    fail > 0 || opts.checks.length === 0 || pass === 0 ? "fail" : "pass";
  return {
    mode: opts.mode,
    profile: opts.profile,
    target: opts.target,
    startedAtMs: opts.startedAtMs ?? Date.now(),
    durationMs: opts.durationMs ?? 0,
    checks: opts.checks,
    summary: { pass, fail, na, total: opts.checks.length },
    result,
  };
}

const MARK: Record<CheckStatus, string> = { pass: "✔", fail: "✖", na: "–" };

/** Human-readable lines (also on --json, so the receipt is never silent). */
export function printReceiptLines(r: Receipt, out: (line: string) => void): void {
  out(`k-harness ${r.mode} (profile ${r.profile}${r.target ? `, target ${r.target}` : ""})`);
  for (const c of r.checks) {
    const detail = c.status === "fail" ? ` — ${c.error}` : "";
    out(`  ${MARK[c.status]} ${c.id} (${c.durationMs}ms)${detail}`);
  }
  out(
    `result: ${r.result} — ${r.summary.pass} pass, ${r.summary.fail} fail, ${r.summary.na} na (${r.summary.total} checks, ${r.durationMs}ms)`,
  );
}

export function printReceipt(r: Receipt, json: boolean, out: (line: string) => void = console.log): void {
  if (json) {
    out(JSON.stringify(r, null, 2));
    return;
  }
  printReceiptLines(r, out);
}
