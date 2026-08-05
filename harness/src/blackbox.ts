/**
 * Black-box `--bin` mode (harness-design §1.75/§1.76).
 *
 * Given a REAL binary (`k-harness --bin ./mytool`), the harness:
 *  1. reads the binary's `k.json` command declarations (defaults: version
 *     `["--version"]`, selfUpgrade `["self","upgrade"]` when absent);
 *  2. starts a fake-server and publishes a target release via
 *     artifact-factory (the fixture loop);
 *  3. drives the binary through its declared commands and asserts from
 *     OUTSIDE: exit codes, on-disk bytes, next-run version.
 *
 * Contract checks are typed FAILs (CONTRACT_* codes) — they are mechanical
 * acceptance, NOT tooth-review material (§1.76 ③: k.json commands that
 * don't run / status output that violates the schema fail directly).
 *
 * Config surface: the binary reads its releaseBase from the K_RELEASE_BASE
 * env var (the demo's contract; real apps wire their own config).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type Profile } from "./teeth/registry.ts";
import { createSandbox } from "./scenario/sandbox.ts";
import { buildReceipt, type CheckResult, type Receipt } from "./receipt.ts";
import { FakeServer } from "./fake-server/server.ts";
import { ArtifactFactory } from "./artifact-factory/factory.ts";
import { runCommand } from "./artifact-factory/run.ts";
import { sha256Hex } from "./fake-server/manifest.ts";
import { loadKJson, type KJson } from "./kjson.ts";

export { loadKJson, defaultKJson, type KJson, DEFAULT_VERSION_ARGS, DEFAULT_SELF_UPGRADE_ARGS } from "./kjson.ts";

export const DEFAULT_TARGET_VERSION = "2.0.0";
export const RELEASE_BASE_ENV = "K_RELEASE_BASE";

/** Run a declared command; returns the raw result (contract checks decide). */
async function runDeclared(binPath: string, args: string[], env: Record<string, string>) {
  return runCommand(binPath, args, { env });
}

/** sha256 of the binary's own file (the "on-disk" external assertion). */
async function fileSha256(binPath: string): Promise<string> {
  return sha256Hex(new Uint8Array(await fs.readFile(binPath)));
}

/**
 * §1.76 ① status output schema: {ProcessEvidence, TxnState,
 * ConvergenceReport} — the three existing core types, no new schema.
 * Returns null when valid, else a human-readable reason.
 */
export function validateStatusOutput(text: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return "status output is not valid JSON";
  }
  if (typeof obj !== "object" || obj === null) return "status output must be a JSON object";
  const o = obj as Record<string, unknown>;

  const evidence = o.ProcessEvidence as Record<string, unknown> | undefined;
  if (!evidence) return "missing ProcessEvidence";
  if (typeof evidence.version !== "string") return "ProcessEvidence.version must be a string";
  if (typeof evidence.pid !== "number") return "ProcessEvidence.pid must be a number";
  if (typeof evidence.startId !== "string") return "ProcessEvidence.startId must be a string";

  const txn = o.TxnState as Record<string, unknown> | undefined;
  if (!txn) return "missing TxnState";
  const PHASES = [
    "idle",
    "staged",
    "handing-over",
    "running-experiment",
    "readback",
    "promoted",
    "rolled-back",
  ];
  if (typeof txn.phase !== "string" || !PHASES.includes(txn.phase)) {
    return `TxnState.phase must be one of ${PHASES.join("/")}`;
  }
  if (typeof txn.stableVersion !== "string") return "TxnState.stableVersion must be a string";
  if (txn.experimentVersion !== null && typeof txn.experimentVersion !== "string") {
    return "TxnState.experimentVersion must be a string or null";
  }
  if (txn.rollbackReason !== null && typeof txn.rollbackReason !== "string") {
    return "TxnState.rollbackReason must be a string or null";
  }

  const converge = o.ConvergenceReport as Record<string, unknown> | undefined;
  if (!converge) return "missing ConvergenceReport";
  for (const key of ["binaryAtTarget", "hostLifecycleConverged"] as const) {
    const pred = converge[key] as Record<string, unknown> | undefined;
    if (!pred) return `ConvergenceReport.${key} missing`;
    if (typeof pred.passed !== "boolean") return `${key}.passed must be a boolean`;
    if (typeof pred.source !== "string") return `${key}.source must be a string`;
    if (typeof pred.observedAtMs !== "number") return `${key}.observedAtMs must be a number`;
    if (typeof pred.detail !== "object" || pred.detail === null) {
      return `${key}.detail must be an object`;
    }
  }
  return null;
}

export interface BinModeOptions {
  binPath: string;
  profile: Profile;
  targetVersion?: string;
  /** Injectable server for tests that want a pre-seeded release store. */
  server?: FakeServer;
}

/** The three contract checks of bin mode, run sequentially in one sandbox. */
export async function runBinMode(opts: BinModeOptions): Promise<Receipt> {
  const startedAtMs = Date.now();
  const binPath = path.resolve(opts.binPath);
  const binDir = path.dirname(binPath);
  const targetVersion = opts.targetVersion ?? DEFAULT_TARGET_VERSION;
  const checks: CheckResult[] = [];

  const sb = await createSandbox({ prefix: "k-harness-bin" });
  const server = opts.server ?? new FakeServer({ storeDir: path.join(sb.dir, "store") });
  const startedServer = opts.server === undefined;
  try {
    // Binary-present guard: a missing binary is a typed FAIL, not a crash.
    let binStat;
    try {
      binStat = await fs.stat(binPath);
    } catch {
      checks.push({
        id: "contract.binary-present",
        status: "fail",
        error: "CONTRACT_BIN_MISSING: binary does not exist",
        durationMs: 0,
      });
      return buildReceipt({
        mode: "bin",
        profile: opts.profile,
        target: binPath,
        checks,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
      });
    }
    checks.push({ id: "contract.binary-present", status: "pass", error: null, durationMs: 0 });
    if (!(binStat.mode & 0o111)) {
      checks.push({
        id: "contract.binary-executable",
        status: "fail",
        error: "CONTRACT_BIN_NOT_EXECUTABLE: binary is not executable",
        durationMs: 0,
      });
      return buildReceipt({
        mode: "bin",
        profile: opts.profile,
        target: binPath,
        checks,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
      });
    }
    checks.push({ id: "contract.binary-executable", status: "pass", error: null, durationMs: 0 });

    if (startedServer) await server.start();

    // k.json declaration check — malformed declarations are a typed FAIL.
    const tKJson = Date.now();
    let kjson: KJson;
    try {
      kjson = await loadKJson(binDir);
      checks.push(passCheck("contract.kjson-declarations", tKJson));
    } catch (err) {
      checks.push(
        failCheck(
          "contract.kjson-declarations",
          "CONTRACT_KJSON_MALFORMED",
          (err as Error).message.replace(/^CONTRACT_KJSON_MALFORMED: ?/, ""),
          tKJson,
        ),
      );
      // The declared commands cannot be trusted; stop with the typed failure.
      return buildReceipt({
        mode: "bin",
        profile: opts.profile,
        target: binPath,
        checks,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
      });
    }

    // Publish the target release (artifact-factory closes the loop).
    const factory = new ArtifactFactory({ cacheDir: path.join(sb.dir, "cache") });
    await factory.makeRelease({
      version: targetVersion,
      behavior: "ok",
      store: server.store,
    });

    const env = { [RELEASE_BASE_ENV]: server.url };

    // Contract 1: the declared version command runs and prints a version.
    {
      const t0 = Date.now();
      const r = await runDeclared(binPath, kjson.version ?? [], env);
      if (r.timedOut) {
        checks.push(failCheck("contract.version-command", "CONTRACT_CMD_TIMEOUT", "version command timed out", t0));
      } else if (r.code !== 0) {
        checks.push(failCheck("contract.version-command", "CONTRACT_CMD_EXIT", `version command exited ${r.code}: ${r.stderr.trim()}`, t0));
      } else if (r.stdout.trim() === "") {
        checks.push(failCheck("contract.version-command", "CONTRACT_CMD_EMPTY_OUTPUT", "version command printed nothing", t0));
      } else {
        checks.push(passCheck("contract.version-command", t0));
      }
    }

    // Contract 2: self upgrade — on-disk bytes change, next run is the target.
    {
      const t0 = Date.now();
      const before = await fileSha256(binPath);
      const r = await runDeclared(binPath, kjson.selfUpgrade ?? [], env);
      const after = await fileSha256(binPath);
      if (r.timedOut) {
        checks.push(failCheck("contract.self-upgrade", "CONTRACT_CMD_TIMEOUT", "self upgrade timed out", t0));
      } else if (r.code !== 0) {
        checks.push(failCheck("contract.self-upgrade", "CONTRACT_CMD_EXIT", `self upgrade exited ${r.code}: ${r.stderr.trim()}`, t0));
      } else if (after === before) {
        checks.push(failCheck("contract.self-upgrade", "CONTRACT_UPGRADE_SELF_UNCHANGED", "binary bytes unchanged after upgrade", t0));
      } else {
        const v = await runDeclared(binPath, kjson.version ?? [], env);
        if (v.timedOut || v.code !== 0) {
          checks.push(failCheck("contract.self-upgrade", "CONTRACT_NEXT_RUN_VERSION", `next-run version command failed (exit ${v.code})`, t0));
        } else if (v.stdout.trim() === targetVersion) {
          checks.push(passCheck("contract.self-upgrade", t0));
        } else {
          checks.push(failCheck("contract.self-upgrade", "CONTRACT_NEXT_RUN_VERSION", `next run reports ${JSON.stringify(v.stdout.trim())}, expected ${targetVersion}`, t0));
        }
      }
    }

    // Contract 3: status schema — only when the binary declares status.
    if (kjson.status) {
      const t0 = Date.now();
      const r = await runDeclared(binPath, kjson.status, env);
      const schemaError = r.timedOut
        ? "status command timed out"
        : r.code === 0
          ? validateStatusOutput(r.stdout)
          : `status exited ${r.code}`;
      if (schemaError) {
        checks.push(failCheck("contract.status-schema", "CONTRACT_STATUS_SCHEMA", schemaError, t0));
      } else {
        checks.push(passCheck("contract.status-schema", t0));
      }
    } else {
      checks.push({ id: "contract.status-schema", status: "na", error: null, durationMs: 0 });
    }
  } finally {
    if (startedServer) await server.stop();
    await sb.teardown();
  }

  return buildReceipt({
    mode: "bin",
    profile: opts.profile,
    target: binPath,
    checks,
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
  });
}

function passCheck(id: string, startedAtMs: number): CheckResult {
  return { id, status: "pass", error: null, durationMs: Date.now() - startedAtMs };
}

function failCheck(id: string, code: string, message: string, startedAtMs: number): CheckResult {
  return { id, status: "fail", error: `${code}: ${message}`, durationMs: Date.now() - startedAtMs };
}
