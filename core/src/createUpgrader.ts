/**
 * createUpgrader — the one construction every entrypoint uses.
 *
 * Order of gates, and why each is where it is:
 *   1. lock        one transaction per service identity; two entrypoints can
 *                  fire at once, and interleaving them would make "what
 *                  happened" undefined.
 *   2. ownership   a copy owned by another manager never upgrades itself.
 *   3. source      what should we be on (or: this exact version)?
 *   4. policy      consent BEFORE any disk side effect.
 *   5. compat      the host's own semantic gate, before staging.
 *   6. download    fetch + verify; unverified bytes never reach a slot.
 *   7. engine      stage -> handoff -> predicates -> promote / rollback.
 *
 * Everything before (7) can only produce `held` or `up-to-date`: nothing has
 * been changed on disk yet. That is what makes a refusal cheap and a rollback
 * rare rather than routine.
 */
import type { Upgrader, UpgraderConfig, UpgradeOutcome } from "./upgrader.ts";
import type { TxnState } from "./txn/state.ts";
import type { Release } from "./artifact/source.ts";
import type { ProcessEvidence } from "./lifecycle/hostAdapter.ts";
import { UpgradeEngine } from "./txn/engine.ts";
import { fileEffects, materializeArtifact } from "./txn/fileEffects.ts";
import { acquireUpgradeLock } from "./txn/lock.ts";
import { downloadVerified } from "./artifact/download.ts";
import { ArtifactError } from "./artifact/errors.ts";
import * as path from "node:path";
import { systemClock, type Clock } from "./clock.ts";
import { buildSurfaceAllowlist, evaluateLifecycleConvergence } from "./converge/lifecycle.ts";
import type { ReadbackSurface, ConvergenceReport, PredicateResult } from "./converge/predicates.ts";
import { platformOpsFor } from "./platform/index.ts";
import { buildConvergenceReport } from "./converge/report.ts";
import { slotArtifactPath } from "./txn/fileEffects.ts";

export interface CreateUpgraderOptions extends UpgraderConfig {
  clock?: Clock;
  /** Reports who owns this install; default: we own it. */
  installOwnership?: () => "self" | "managed-elsewhere";
  /** Optional host semantic gate; a string result refuses the transition. */
  checkCompatibility?: (from: string, to: string) => Promise<string | null>;
  /**
   * The OS-lifecycle read-back surfaces the app's platform adapter
   * declares (host_lifecycle_converged, design-v1 §L3). Each surface is
   * read during readback; convergence requires it to reference the
   * artifact being promoted. Surfaces NOT declared here are refused —
   * an app can only vouch for surfaces it actually ships.
   */
  lifecycleSurfaces?: ReadbackSurface[];
}

export function createUpgrader(opts: CreateUpgraderOptions): Upgrader {
  const clock = opts.clock ?? systemClock;
  const effects = fileEffects(opts.stateDir);
  const ownership = opts.installOwnership ?? ((): "self" => "self");

  // The last predicate evidence, captured for the promote report (the
  // engine only carries pass/fail; the report needs the real results).
  let lastEvidence: ProcessEvidence | null = null;
  let lastLifecycle: PredicateResult | null = null;
  /** The report of the last promote (the retirement gate reads it). */
  let lastReport: ConvergenceReport | null = null;

  const engine = new UpgradeEngine({
    effects,
    host: opts.host,
    clock,
    evaluatePredicates: async (evidence: ProcessEvidence, targetVersion: string) => {
      lastEvidence = evidence;
      if (evidence.version !== targetVersion) {
        return `live process reports ${evidence.version}, expected ${targetVersion}`;
      }
      if (opts.lifecycleSurfaces && opts.lifecycleSurfaces.length > 0) {
        // host_lifecycle_converged: every declared surface must read back
        // the artifact being promoted (projection ban: metadata cannot).
        const allowlist = buildSurfaceAllowlist(
          opts.lifecycleSurfaces.map((surface) => ({
            surface,
            expectedTarget: slotArtifactPath(opts.stateDir, "experiment"),
          })),
        );
        const result = await evaluateLifecycleConvergence(allowlist, clock.nowMs());
        lastLifecycle = result;
        if (!result.passed) {
          return `lifecycle surface ${result.source} did not converge: ${JSON.stringify(result.detail)}`;
        }
      }
      return null;
    },
  });

  async function currentVersion(): Promise<string> {
    return (await effects.slots.slotVersions()).stable ?? "0.0.0";
  }

  async function notify(kind: Parameters<UpgraderConfig["notificationSink"]>[0]["kind"], detail: Record<string, string>): Promise<void> {
    await opts.notificationSink({ kind, detail });
  }

  /** Gates 1-7. `pick` chooses which release to run. `consented` means the
   * user approved THIS SPECIFIC release (a confirm-request was shown and
   * answered for it) — the policy gate is skipped, everything else stands. */
  async function run(
    pick: (current: string) => Promise<Release | null>,
    consented = false,
  ): Promise<UpgradeOutcome> {
    const owner = ownership();
    if (owner === "managed-elsewhere") {
      await notify("held", { reason: "managed-elsewhere" });
      return { result: "held", reason: "this install is managed by another manager; it does not upgrade itself" };
    }

    const lock = await acquireUpgradeLock(opts.stateDir, clock.nowMs());
    try {
      await engine.recover(); // finish or undo anything a previous crash left

      const current = await currentVersion();
      let release: Release | null;
      try {
        release = await pick(current);
      } catch (err) {
        // Consent is to a SPECIFIC version: if the source can no longer
        // serve it (the publisher moved on), the approval is void — a typed
        // refusal, never a silent switch to whatever is current now.
        if (consented && err instanceof ArtifactError && err.code === "PINNED_VERSION_MISMATCH") {
          await notify("held", { reason: "consented-version-unavailable", version: current });
          return {
            result: "held",
            reason: `the approved version is no longer served; nothing was installed`,
          };
        }
        throw err;
      }
      if (release === null) return { result: "up-to-date" };

      if (!consented && opts.policy === "notify-only") {
        await notify("held", { reason: "notify-only", version: release.version });
        return { result: "held", reason: `policy is notify-only; ${release.version} is available` };
      }
      if (!consented && opts.policy === "confirm") {
        await notify("confirm-request", { version: release.version, current });
        return { result: "held", reason: `policy requires confirmation before upgrading to ${release.version}` };
      }

      if (opts.checkCompatibility) {
        const refusal = await opts.checkCompatibility(current, release.version);
        if (refusal !== null) {
          await notify("held", { reason: "incompatible", detail: refusal });
          return { result: "held", reason: `incompatible: ${refusal}` };
        }
      }

      // Resume support: an interrupted download (process death
      // mid-fetch) leaves its prefix in stateDir/incoming and the next
      // attempt continues via Range instead of restarting from zero.
      const bytes = await downloadVerified(release, {
        clock,
        resumeDir: path.join(opts.stateDir, "incoming"),
      });

      // NOTE: K verifies INTEGRITY (sha256 + size) but deliberately does not
      // verify AUTHENTICITY. See docs/design-v1.md §L0.5 — signing was removed
      // on 2026-08-06 rather than shipped half-used. A digest proves the bytes
      // are the ones the manifest described; it cannot prove who produced
      // them, because it travels with them.
      const bytesRef = await materializeArtifact(opts.stateDir, bytes);

      const outcome = await engine.upgrade({ version: release.version, bytesRef });
      if (outcome.result === "promoted") {
        await notify("promoted", { version: outcome.version });
        lastReport = buildConvergenceReport({
          version: outcome.version,
          evidence: lastEvidence,
          lifecycle: lastLifecycle,
          declaredSurfaces: (opts.lifecycleSurfaces ?? []).length,
          nowMs: clock.nowMs(),
        });
        return { result: "promoted", report: lastReport };
      }
      if (outcome.result === "rolled-back") {
        await notify("rolled-back", { reason: outcome.reason });
        return { result: "rolled-back", reason: outcome.reason, report: null };
      }
      return { result: "up-to-date" };
    } finally {
      await lock.release();
    }
  }

  return {
    async check(): Promise<{ current: string; target: string | null }> {
      const current = await currentVersion();
      const release = await opts.source.checkForUpdate({
        currentVersion: current,
        platformKey: platformOpsFor().platformKey(),
      });
      return { current, target: release?.version ?? null };
    },

    async upgrade(): Promise<UpgradeOutcome> {
      return run(async (current) =>
        opts.source.checkForUpdate({ currentVersion: current, platformKey: platformOpsFor().platformKey() }),
      );
    },

    async upgradeTo(version: string, opts2?: { consented?: boolean }): Promise<UpgradeOutcome> {
      return run(
        async (current) =>
          opts.source.fetchRelease(version, {
            currentVersion: current,
            platformKey: platformOpsFor().platformKey(),
          }),
        opts2?.consented === true,
      );
    },

    async retireLegacyManager(): Promise<"retired" | { held: string }> {
      // Retire the legacy lifecycle manager ONLY after convergence passed;
      // otherwise the machine would be left with no supervisor — a HOLD.
      const report = lastReport;
      const lifecycle = report?.hostLifecycleConverged ?? null;
      if (lifecycle === null) {
        return {
          held:
            "cannot retire the legacy lifecycle manager before host_lifecycle_converged passed" +
            (report === null
              ? " (no upgrade has converged yet)"
              : " (this app declared no OS-lifecycle read-back surface, so it was never observed)"),
        };
      }
      if (!lifecycle.passed) {
        return {
          held:
            "cannot retire the legacy lifecycle manager before host_lifecycle_converged passed",
        };
      }
      return "retired";
    },

    async rollback(reason: string): Promise<void> {
      const lock = await acquireUpgradeLock(opts.stateDir, clock.nowMs());
      try {
        await engine.recover();
        await effects.slots.clearExperiment();
        await notify("rolled-back", { reason });
      } finally {
        await lock.release();
      }
    },

    async state(): Promise<TxnState> {
      const slots = await effects.slots.slotVersions();
      const intents = (await effects.journal.readAll()).map((e) => e.intent);
      return {
        phase: intents.at(-1) ?? "idle",
        stableVersion: slots.stable ?? "0.0.0",
        experimentVersion: slots.experiment,
        rollbackReason: null,
      };
    },
  };
}
