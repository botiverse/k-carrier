#!/usr/bin/env node
/**
 * k-harness — the harness CLI (harness-design §1.75/§1.76).
 *
 *   k-harness --list [--profile <p>]            what cases exist, and where to read one
 *   k-harness --profile <swap|service>          run the tier-filtered teeth
 *   k-harness --bin ./mytool [--profile swap]          black-box: drive the real
 *                                                     binary through its declared
 *                                                     commands (k.target.ts REQUIRED)
 *   k-harness --adapter <path> [--profile service]    run the adopter contract subset
 *                                                     against an external adapter
 *   k-harness sim [--seed N | --seeds N --start-seed N]  seeded deterministic simulation
 *   k-harness --json                                  machine-readable receipt
 *   k-harness --target-version <v>                    version served by --bin mode
 *   k-harness --target <path>                         explicit target file for --bin
 *   k-harness --help
 *
 * Exit code 0 iff the receipt result is "pass". Receipt: structured, human
 * + CI readable (harness-design §1.3).
 */
import { runProfile, runAdapter } from "./runner.ts";
import { allTeeth, teethFor, ALL_CAPABILITIES } from "./teeth/registry.ts";
import "./teeth/index.ts"; // registers all teeth (side effect)
import { runBinMode, type BinModeOptions } from "./blackbox.ts";
import { printReceipt } from "./receipt.ts";
import type { Profile } from "./teeth/registry.ts";
import { SMOKE_SEEDS, sequentialSeeds } from "./sim/corpus.ts";
import { runSimulationBatch, type SimulationBatch } from "./sim/run.ts";
import { recordFailures } from "./sim/record.ts";

const USAGE = `k-harness — K acceptance harness

Usage:
  k-harness --list [--profile <swap|service>] [--json]
  k-harness --profile <swap|service> [--json]
  k-harness --bin <path-to-binary> [--profile swap] [--target-version <v>] [--target <path>] [--json]
  k-harness --adapter <path-to-module> [--profile service] [--json]
  k-harness sim [--seed <uint32> | --seeds <count> [--start-seed <uint32>]] [--record-failures <path>] [--json]
  k-harness --help

Options:
  --list               list the acceptance cases (teeth) and where each is defined
  --profile <p>        tier-filtered tooth set (swap | service)
  --bin <path>         black-box mode: drive a real binary (k.target.ts REQUIRED)
  --adapter <path>     adapter mode: contract subset against an external adapter
                       (module default export: (stateDir) => HostDriver)
  sim                  deterministic simulator; no seed flags = fixed PR smoke corpus
  --seed <n>           replay one exact uint32 seed (decimal or 0x...)
  --seeds <n>          run n sequential seeds (nightly/extended mode)
  --start-seed <n>     first seed for --seeds (default 1)
  --record-failures <path>
                       atomically merge failing seeds here (default .k-harness/sim-failures.json)
  --target <path>      explicit target file for --bin (default <bin-dir>/k.target.ts)
  --target-version <v> version the --bin fake-server serves (default 2.0.0)
  --json               print the receipt as JSON (human lines always printed)
  --help               this message
`;

function parseArgs(argv: string[]): {
  list: boolean;
  profile: Profile | null;
  binPath: string | null;
  adapterPath: string | null;
  targetVersion: string | null;
  targetPath: string | null;
  json: boolean;
  sim: boolean;
  seed: number | null;
  seedCount: number | null;
  startSeed: number | null;
  failurePath: string;
} {
  const out = {
    list: false,
    profile: null as Profile | null,
    binPath: null as string | null,
    adapterPath: null as string | null,
    targetVersion: null as string | null,
    targetPath: null as string | null,
    json: false,
    sim: false,
    seed: null as number | null,
    seedCount: null as number | null,
    startSeed: null as number | null,
    failurePath: ".k-harness/sim-failures.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`flag ${arg} requires a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--profile": {
        const v = next();
        if (v !== "swap" && v !== "service" && v !== "service") {
          throw new Error(`--profile must be swap|service, got ${v}`);
        }
        out.profile = v;
        break;
      }
      case "--bin":
        out.binPath = next();
        break;
      case "--adapter":
        out.adapterPath = next();
        break;
      case "sim":
        out.sim = true;
        break;
      case "--seed":
        out.seed = parseUint32(next(), "--seed");
        break;
      case "--seeds":
        out.seedCount = parsePositiveInteger(next(), "--seeds");
        break;
      case "--start-seed":
        out.startSeed = parseUint32(next(), "--start-seed");
        break;
      case "--record-failures":
        out.failurePath = next();
        break;
      case "--target-version":
        out.targetVersion = next();
        break;
      case "--target":
        out.targetPath = next();
        break;
      case "--list":
        out.list = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
        return out;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return out;
}

function parseUint32(raw: string, flag: string): number {
  const value = /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${flag} must be a uint32, got ${raw}`);
  }
  return value >>> 0;
}

function parsePositiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${raw}`);
  }
  return value;
}

function printSimulation(batch: SimulationBatch, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(batch, null, 2));
    return;
  }
  console.log(`k-harness sim (${batch.summary.total} seeds)`);
  for (const result of batch.results.filter((item) => item.status === "fail")) {
    console.log(`  ✖ seed ${result.seed} — ${result.failure}`);
    console.log(`    replay: ${result.replay}`);
  }
  console.log(
    `faults: delay=${batch.coverage.delay} crash-before=${batch.coverage["crash-before"]} crash-after=${batch.coverage["crash-after"]} fail-before=${batch.coverage["fail-before"]} partial-write=${batch.coverage["partial-write"]} reorder-volatile=${batch.coverage["reorder-volatile"]}`,
  );
  console.log(`result: ${batch.result} — ${batch.summary.pass} pass, ${batch.summary.fail} fail`);
}

/**
 * Print the case inventory. Answers "which acceptance cases exist and where
 * do I read one" -- previously only answerable by grepping, because a tooth
 * is deliberately split across three files (registration / body / self-check)
 * and none of them is a list.
 *
 * `where` is the registration site, captured at registration rather than
 * declared, so it cannot drift from the code it points at.
 */
function listTeeth(profile: Profile | null, json: boolean): void {
  const teeth = profile ? teethFor(profile, ALL_CAPABILITIES) : allTeeth();
  if (json) {
    console.log(JSON.stringify(
      teeth.map((t) => ({
        id: t.id,
        profiles: t.profiles,
        layers: t.layers,
        kind: t.kind.kind,
        mustRed: t.mustRed.map((m) => m.mutate),
        where: t.registeredAt ?? null,
      })),
      null,
      2,
    ));
    return;
  }
  const scope = profile ? `profile ${profile}` : "all profiles";
  console.log(`k-harness: ${teeth.length} acceptance cases (${scope})\n`);
  for (const t of teeth) {
    console.log(`${t.id}`);
    console.log(`  ${t.kind.kind} · layers ${t.layers.join(",")} · profiles ${t.profiles.join(",")}`);
    console.log(`  defined at ${t.registeredAt ?? "(unknown)"}`);
    // The must-red list is the honest part: it is what this case claims it
    // would catch. A case with a vague one is a case that proves little.
    for (const m of t.mustRed) console.log(`  goes red if: ${m.mutate}`);
    console.log("");
  }
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  if (raw.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(raw);
  if (args.list) {
    listTeeth(args.profile, args.json);
    return 0;
  }
  if (args.sim) {
    if (args.binPath || args.adapterPath || args.profile !== null) {
      throw new Error("sim is mutually exclusive with --profile, --bin, and --adapter");
    }
    if (args.seed !== null && args.seedCount !== null) {
      throw new Error("--seed and --seeds are mutually exclusive");
    }
    if (args.startSeed !== null && args.seedCount === null) {
      throw new Error("--start-seed requires --seeds");
    }
    let seeds: number[];
    if (args.seed === null) {
      seeds =
        args.seedCount === null
          ? [...SMOKE_SEEDS]
          : sequentialSeeds(args.startSeed ?? 1, args.seedCount);
    } else {
      seeds = [args.seed];
    }
    const batch = await runSimulationBatch(seeds);
    if (batch.result === "fail") {
      await recordFailures(args.failurePath, batch.results);
    }
    printSimulation(batch, args.json);
    return batch.result === "pass" ? 0 : 1;
  }
  if (args.binPath && args.adapterPath) throw new Error("--bin and --adapter are mutually exclusive");
  if (!args.binPath && !args.adapterPath && !args.profile) throw new Error("need one of --list, --profile, --bin, --adapter, sim");

  const profile: Profile = args.profile ?? (args.binPath ? "swap" : "service");

  let receipt;
  if (args.binPath) {
    const binOpts: BinModeOptions = { binPath: args.binPath, profile };
    if (args.targetVersion !== null) binOpts.targetVersion = args.targetVersion;
    if (args.targetPath !== null) binOpts.targetPath = args.targetPath;
    receipt = await runBinMode(binOpts);
  } else if (args.adapterPath) {
    receipt = await runAdapter(profile, args.adapterPath);
  } else {
    receipt = await runProfile(profile);
  }
  printReceipt(receipt, args.json);
  return receipt.result === "pass" ? 0 : 1;
}

try {
  const code = await main();
  process.exitCode = code;
} catch (err) {
  console.error(`k-harness: ${(err as Error).message}`);
  console.error(USAGE);
  process.exitCode = 2;
}
