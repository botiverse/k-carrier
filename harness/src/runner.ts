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
import { teethFor, type Profile, type ToothContext } from "./teeth/registry.ts";
import { checkAdapterReleaseKnob } from "./adapter/releaseKnob.ts";
import { checkAdapterProbeBindsLiveProcess } from "./adapter/probeChecks.ts";
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
import {
  checkAdapterServiceUpgrade,
  checkAdapterServiceRollback,
  checkAdapterLifecycleConverged,
  type ServiceAdapterFactory,
} from "./adapter/serviceChecks.ts";

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
  const teeth = teethFor(profile);
  // Fail-closed: an empty selection must never render as "all green"
  // (zero teeth and all-passed are indistinguishable to CI otherwise).
  if (teeth.length === 0) {
    return buildReceipt({
      mode: "profile",
      profile,
      target: null,
      checks: [
        {
          id: "harness.empty-selection",
          status: "fail",
          error: `HARNESS_EMPTY_SELECTION: profile ${profile} selected 0 teeth`,
          durationMs: 0,
        },
      ],
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
    });
  }
  const checks: CheckResult[] = [];
  for (const tooth of teeth) {
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
export async function loadAdapter(adapterPath: string): Promise<ServiceAdapterFactory> {
  const mod = (await import(pathToFileURL(adapterPath).href)) as { default?: unknown };
  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new TypeError(
      `adapter ${adapterPath}: default export must be a factory function (stateDir) => HostDriver`,
    );
  }
  return factory as ServiceAdapterFactory;
}

export async function runAdapter(profile: Profile, adapterPath: string): Promise<Receipt> {
  const startedAtMs = Date.now();
  const factory = await loadAdapter(adapterPath);
  // Fail-closed: an empty contract-check list must never render green.
  if (ADAPTER_CHECKS.length === 0) {
    return buildReceipt({
      mode: "adapter",
      profile,
      target: adapterPath,
      checks: [
        {
          id: "harness.empty-selection",
          status: "fail",
          error: `HARNESS_EMPTY_SELECTION: adapter contract subset selected 0 checks`,
          durationMs: 0,
        },
      ],
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
    });
  }
  const checks: CheckResult[] = [];
  // Shape probe: the inproc-driver marker (doWork/ledger) selects the
  // contract subset; the lifecycleSurfaces marker selects the service-tier
  // checks. An adapter with NEITHER implements no recognizable contract.
  const inprocDriver = await (async () => {
    const sb = await createSandbox({ prefix: "adapter-probe-driver" });
    try {
      return hasWorkloadDriver(factory(sb.dir));
    } finally {
      await sb.teardown();
    }
  })();
  const serviceTier = await (async () => {
    const sb = await createSandbox({ prefix: "adapter-probe-service" });
    try {
      const host = factory(sb.dir);
      return typeof (host as { lifecycleSurfaces?: unknown }).lifecycleSurfaces === "function";
    } finally {
      await sb.teardown();
    }
  })();
  if (!inprocDriver && !serviceTier) {
    checks.push({
      id: "adapter.must-declare-a-contract",
      status: "fail",
      error:
        "HARNESS_ADAPTER_SHAPE: the adapter implements neither the inproc workload driver (doWork/ledger) nor the service-tier lifecycle surfaces — nothing is testable without a backdoor",
      durationMs: 0,
    });
  }

  for (const { id, run } of ADAPTER_CHECKS) {
    checks.push(
      await runCheck(id, async () => {
        const sb = await createSandbox({ prefix: id.replaceAll(".", "-") });
        try {
          if (!inprocDriver) return { skipped: true };
          const host = factory(sb.dir);
          await run({ profile, sandboxDir: sb.dir }, host);
        } finally {
          await sb.teardown();
        }
        return { skipped: false };
      }),
    );
  }

  // Service-tier adapter acceptance: the SAME assertions as the service
  // teeth (upgrade / rollback / lifecycle-converged), host swapped for the
  // external adapter (archer: "同一套齿，换一个宿主实现"). Gated on the
  // adapter declaring lifecycle surfaces — the service-tier marker; an
  // adapter without them is a contract-subset-only host and the checks are
  // skipped (like the ledger checks' driver skip).
  if (profile === "service") {
    const serviceChecks: Array<{
      id: string;
      needsSurfaces?: boolean;
      run: (ctx: ToothContext, f: ServiceAdapterFactory) => Promise<void>;
    }> = [
      // First: every check below has a negative control that works by serving
      // a crash-on-start release. If the adopter's source ignores the knob,
      // those controls are no-ops and the passes below mean nothing -- so this
      // is reported before them, not after.
      { id: "adapter.service-release-knob-bites", run: (ctx, f) => checkAdapterReleaseKnob(ctx, f) },
      {
        id: "adapter.service-probe-binds-live-process",
        run: (ctx, f) => checkAdapterProbeBindsLiveProcess(ctx, f),
      },
      { id: "adapter.service-upgrade", run: (ctx, f) => checkAdapterServiceUpgrade(ctx, f) },
      { id: "adapter.service-rollback", run: (ctx, f) => checkAdapterServiceRollback(ctx, f) },
      {
        id: "adapter.lifecycle-converged",
        // Lifecycle convergence is an opt-in CAPABILITY, not part of being a
        // service. An adopter that drives no OS-lifecycle surface (a plain
        // detached owner, say) has nothing to converge, and failing it for
        // that would push adopters toward declaring a surface they do not
        // actually read -- the projection L3 bans, invited by the harness.
        //
        // It reports `na`, never `pass`: exactly what core does with
        // `hostLifecycleConverged: null`. Silence keeps its own value here too,
        // so a receipt can never be read as "convergence checked".
        needsSurfaces: true,
        run: (ctx, f) => checkAdapterLifecycleConverged(ctx, f),
      },
    ];
    for (const { id, needsSurfaces, run } of serviceChecks) {
      checks.push(
        await runCheck(id, async () => {
          const sb = await createSandbox({ prefix: id.replaceAll(".", "-") });
          try {
            if (!serviceTier) return { skipped: true };
            if (needsSurfaces === true && (factory(sb.dir).lifecycleSurfaces?.() ?? []).length === 0) {
              return { skipped: true };
            }
            await run({ profile, sandboxDir: sb.dir }, factory);
          } finally {
            await sb.teardown();
          }
          return { skipped: false };
        }),
      );
    }
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
