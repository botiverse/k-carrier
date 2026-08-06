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

const USAGE = `k-harness — K acceptance harness

Usage:
  k-harness --list [--profile <swap|service>] [--json]
  k-harness --profile <swap|service> [--json]
  k-harness --bin <path-to-binary> [--profile swap] [--target-version <v>] [--target <path>] [--json]
  k-harness --adapter <path-to-module> [--profile service] [--json]
  k-harness --help

Options:
  --list               list the acceptance cases (teeth) and where each is defined
  --profile <p>        tier-filtered tooth set (swap | service)
  --bin <path>         black-box mode: drive a real binary (k.target.ts REQUIRED)
  --adapter <path>     adapter mode: contract subset against an external adapter
                       (module default export: (stateDir) => HostDriver)
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
} {
  const out = { list: false, profile: null as Profile | null, binPath: null as string | null, adapterPath: null as string | null, targetVersion: null as string | null, targetPath: null as string | null, json: false };
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
  if (args.binPath && args.adapterPath) throw new Error("--bin and --adapter are mutually exclusive");
  if (!args.binPath && !args.adapterPath && !args.profile) throw new Error("need one of --list, --profile, --bin, --adapter");

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
