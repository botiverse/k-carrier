#!/usr/bin/env node
/**
 * k-harness — the harness CLI (harness-design §1.75/§1.76).
 *
 *   k-harness --profile <swap|service|hosted>          run the tier-filtered teeth
 *   k-harness --bin ./mytool [--profile swap]          black-box: drive the real
 *                                                     binary through its declared
 *                                                     commands (k.target.ts REQUIRED)
 *   k-harness --adapter <path> [--profile hosted]    run the adopter contract subset
 *                                                     against an external adapter
 *   k-harness --json                                  machine-readable receipt
 *   k-harness --target-version <v>                    version served by --bin mode
 *   k-harness --target <path>                         explicit target file for --bin
 *   k-harness --help
 *
 * Exit code 0 iff the receipt result is "pass". Receipt: structured, human
 * + CI readable (harness-design §1.3).
 */
import { runProfile, runAdapter } from "./runner.ts";
import "./teeth/index.ts"; // registers all teeth (side effect)
import { runBinMode, type BinModeOptions } from "./blackbox.ts";
import { printReceipt } from "./receipt.ts";
import type { Profile } from "./teeth/registry.ts";

const USAGE = `k-harness — K acceptance harness

Usage:
  k-harness --profile <swap|service|hosted> [--json]
  k-harness --bin <path-to-binary> [--profile swap] [--target-version <v>] [--target <path>] [--json]
  k-harness --adapter <path-to-module> [--profile hosted] [--json]
  k-harness --help

Options:
  --profile <p>        tier-filtered tooth set (cli | daemon | managed)
  --bin <path>         black-box mode: drive a real binary (k.target.ts REQUIRED)
  --adapter <path>     adapter mode: contract subset against an external adapter
                       (module default export: (stateDir) => HostDriver)
  --target <path>      explicit target file for --bin (default <bin-dir>/k.target.ts)
  --target-version <v> version the --bin fake-server serves (default 2.0.0)
  --json               print the receipt as JSON (human lines always printed)
  --help               this message
`;

function parseArgs(argv: string[]): {
  profile: Profile | null;
  binPath: string | null;
  adapterPath: string | null;
  targetVersion: string | null;
  targetPath: string | null;
  json: boolean;
} {
  const out = { profile: null as Profile | null, binPath: null as string | null, adapterPath: null as string | null, targetVersion: null as string | null, targetPath: null as string | null, json: false };
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
        if (v !== "swap" && v !== "service" && v !== "hosted") {
          throw new Error(`--profile must be swap|service|hosted, got ${v}`);
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
      case "--target-version":
        out.targetVersion = next();
        break;
      case "--target":
        out.targetPath = next();
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

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  if (raw.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(raw);
  if (args.binPath && args.adapterPath) throw new Error("--bin and --adapter are mutually exclusive");
  if (!args.binPath && !args.adapterPath && !args.profile) throw new Error("need one of --profile, --bin, --adapter");

  const profile: Profile = args.profile ?? (args.binPath ? "swap" : "hosted");

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
