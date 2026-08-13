import { createHash } from "node:crypto";
import { UpgradeEngine } from "../../../core/src/txn/engine.ts";
import type { WorldSnapshot } from "../../../core/src/invariants.ts";
import { emptyCoverage, type FaultCoverage } from "./scheduler.ts";
import { SimWorld, type SimulationMutation } from "./world.ts";
import { SimulationError } from "./error.ts";

export interface SimulationResult {
  seed: number;
  scenario: "promote" | "predicate-rollback";
  mutation: SimulationMutation | null;
  status: "pass" | "fail";
  restarts: number;
  effects: number;
  coverage: FaultCoverage;
  final: WorldSnapshot;
  failure: string | null;
  replay: string;
  trace: string[];
  transcriptSha256: string;
}

export interface SimulationBatch {
  mode: "sim";
  seeds: number[];
  results: SimulationResult[];
  coverage: FaultCoverage;
  summary: { pass: number; fail: number; total: number };
  result: "pass" | "fail";
}

export interface RunSimulationOptions {
  mutation?: SimulationMutation;
  maxRestarts?: number;
  faults?: boolean;
}

const TARGET = { version: "2.0.0", bytesRef: "sha256:simulated-target" };

export async function runSimulation(
  seed: number,
  opts: RunSimulationOptions = {},
): Promise<SimulationResult> {
  const normalizedSeed = seed >>> 0;
  const world = new SimWorld({
    seed: normalizedSeed,
    ...(opts.mutation ? { mutation: opts.mutation } : {}),
    ...(opts.faults === undefined ? {} : { faults: opts.faults }),
  });
  const predicateRefuses = normalizedSeed % 5 === 0;
  const maxRestarts = opts.maxRestarts ?? 128;
  let restarts = 0;
  let failure: string | null = null;

  for (; restarts <= maxRestarts; restarts++) {
    const engine = new UpgradeEngine({
      effects: world.effects,
      host: world.host,
      clock: world.clock,
      evaluatePredicates: () => world.evaluatePredicates(predicateRefuses),
    });
    try {
      await engine.recover();
      if (world.currentPhase === "promoted" || world.currentPhase === "rolled-back") {
        const problem = world.terminalProblem();
        if (problem !== null) {
          failure = `SIM_TERMINAL_NOT_SETTLED: ${problem}`;
        }
        break;
      }

      // Nothing durable began (for example a crash before the first journal
      // fsync): retry the requested transaction. Once anything is durable,
      // recover() owns the outcome and will settle it instead.
      if (world.durableEntries.length === 0) {
        await engine.upgrade(TARGET);
      } else {
        failure = `SIM_RECOVERY_STALLED: recovery returned in phase ${world.currentPhase}`;
        break;
      }

      const problem = world.terminalProblem();
      if (problem !== null) failure = `SIM_TERMINAL_NOT_SETTLED: ${problem}`;
      break;
    } catch (err) {
      if (err instanceof SimulationError) {
        if (err.kind === "invariant") {
          failure = err.message;
          break;
        }
        world.reboot(err.message);
        continue;
      }
      failure = `SIM_UNEXPECTED: ${(err as Error).stack ?? String(err)}`;
      break;
    }
  }

  if (failure === null && !world.isSettled()) {
    failure =
      restarts > maxRestarts
        ? `SIM_LIVENESS_BUDGET: did not settle within ${maxRestarts} restarts`
        : `SIM_NOT_SETTLED: ${world.terminalProblem() ?? `phase ${world.currentPhase}`}`;
  }

  const base = {
    seed: normalizedSeed,
    scenario: predicateRefuses ? ("predicate-rollback" as const) : ("promote" as const),
    mutation: opts.mutation ?? null,
    status: failure === null ? ("pass" as const) : ("fail" as const),
    restarts,
    effects: world.trace.filter((line) => /^\d+:/.test(line)).length,
    coverage: world.coverage,
    final: world.snapshot(),
    failure,
    replay: `k-harness sim --seed ${normalizedSeed} --json`,
    trace: [...world.trace],
  };
  const transcriptSha256 = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return { ...base, transcriptSha256 };
}

export async function runSimulationBatch(seeds: readonly number[]): Promise<SimulationBatch> {
  if (seeds.length === 0) throw new Error("SIM_EMPTY_SEED_SET: at least one seed is required");
  const results: SimulationResult[] = [];
  const coverage = emptyCoverage();
  for (const seed of seeds) {
    const result = await runSimulation(seed);
    results.push(result);
    for (const key of Object.keys(coverage) as Array<keyof FaultCoverage>) {
      coverage[key] += result.coverage[key];
    }
  }
  const pass = results.filter((result) => result.status === "pass").length;
  const fail = results.length - pass;
  return {
    mode: "sim",
    seeds: results.map((result) => result.seed),
    results,
    coverage,
    summary: { pass, fail, total: results.length },
    result: fail === 0 ? "pass" : "fail",
  };
}

export function replayBytes(result: SimulationResult): string {
  return JSON.stringify(result);
}
