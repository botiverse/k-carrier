/**
 * k-harness runner — executes the two non-bin modes:
 *
 *  - `--profile <cli|daemon|managed>`: runs the tier-filtered tooth set
 *    (teethFor(profile), harness-design §1.5 分档执行), one fresh sandbox
 *    per tooth, into a structured receipt.
 *
 *  - `--adapter <path>`: runs the adopter contract subset (§1.7: no
 *    fault-switch teeth) against an external HostAdapter driver. The
 *    module's default export must be a factory `(stateDir: string) =>
 *    HostDriver`. Ledger checks are marked na when the adapter has no
 *    workload driver; probe contract checks always run.
 */
import { pathToFileURL } from "node:url";
import "./teeth/index.ts"; // registers all teeth (side effect)
import { teethFor, type Profile, type ToothContext } from "./teeth/registry.ts";
import { createSandbox } from "./scenario/sandbox.ts";
import { buildReceipt, type CheckResult, type Receipt } from "./receipt.ts";
import {
  checkLedgerEquivalence,
  checkLedgerEquivalenceAfterRollback,
  checkProbeVersionMatchesSlot,
  checkProbeBindsCurrentIncarnation,
  hasWorkloadDriver,
} from "./fake-host/checks.ts";
import type { HostDriver } from "./fake-host/inproc.ts";

/** Adapter contract subset: quiesce↔resume equivalence + probe 活性 (§1.7). */
const ADAPTER_CHECKS: Array<{ id: string; run: (ctx: ToothContext, host: HostDriver) => Promise<void> }> = [
  {
    id: "adapter.ledger-equivalence",
    run: (ctx, host) => checkLedgerEquivalence(ctx, { host }),
  },
  {
    id: "adapter.ledger-equivalence-after-rollback",
    run: (ctx, host) => checkLedgerEquivalenceAfterRollback(ctx, { host }),
  },
  {
    id: "adapter.probe-version-matches-slot",
    run: (ctx, host) => checkProbeVersionMatchesSlot(ctx, { host }),
  },
  {
    id: "adapter.probe-binds-current-incarnation",
    run: (ctx, host) => checkProbeBindsCurrentIncarnation(ctx, { host }),
  },
];

async function runCheck(
  id: string,
  body: () => Promise<{ skipped: boolean }>,
): Promise<CheckResult> {
  const startedAtMs = Date.now();
  try {
    const { skipped } = await body();
    return {
      id,
      status: skipped ? "na" : "pass",
      error: null,
      durationMs: Date.now() - startedAtMs,
    };
  } catch (err) {
    return {
      id,
      status: "fail",
      error: (err as Error).message,
      durationMs: Date.now() - startedAtMs,
    };
  }
}

export async function runProfile(profile: Profile): Promise<Receipt> {
  const startedAtMs = Date.now();
  const checks: CheckResult[] = [];
  for (const tooth of teethFor(profile)) {
    checks.push(
      await runCheck(tooth.id, async () => {
        const sb = await createSandbox({ prefix: tooth.id.replaceAll(".", "-") });
        try {
          await tooth.run({ profile, sandboxDir: sb.dir });
        } finally {
          await sb.teardown();
        }
        return { skipped: false };
      }),
    );
  }
  return buildReceipt({
    mode: "profile",
    profile,
    target: null,
    checks,
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
  });
}

/** Load an adapter module: default export must be `(stateDir) => HostDriver`. */
export async function loadAdapter(adapterPath: string): Promise<(stateDir: string) => HostDriver> {
  const mod = (await import(pathToFileURL(adapterPath).href)) as { default?: unknown };
  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new TypeError(
      `adapter ${adapterPath}: default export must be a factory function (stateDir) => HostDriver`,
    );
  }
  return factory as (stateDir: string) => HostDriver;
}

export async function runAdapter(profile: Profile, adapterPath: string): Promise<Receipt> {
  const startedAtMs = Date.now();
  const factory = await loadAdapter(adapterPath);
  const checks: CheckResult[] = [];
  for (const { id, run } of ADAPTER_CHECKS) {
    checks.push(
      await runCheck(id, async () => {
        const sb = await createSandbox({ prefix: id.replaceAll(".", "-") });
        try {
          const host = factory(sb.dir);
          if (id.startsWith("adapter.ledger-") && !hasWorkloadDriver(host)) {
            return { skipped: true };
          }
          await run({ profile, sandboxDir: sb.dir }, host);
        } finally {
          await sb.teardown();
        }
        return { skipped: false };
      }),
    );
  }
  return buildReceipt({
    mode: "adapter",
    profile,
    target: adapterPath,
    checks,
    startedAtMs,
    durationMs: Date.now() - startedAtMs,
  });
}
