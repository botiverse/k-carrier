/**
 * createUpgrader — the one construction every entrypoint uses.
 *
 * Order of gates: lock -> ownership -> source -> policy -> compat ->
 * download -> engine. Everything before the engine can only produce `held`
 * or `up-to-date`: nothing on disk has changed. A refusal is cheap; a
 * rollback is rare, not routine.
 */
import type { Upgrader, UpgraderConfig, UpgradeOutcome, ProvenanceIdentity } from "./upgrader.ts";
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
import type { ReadbackSurface, PredicateResult } from "./converge/predicates.ts";
import { platformOpsFor } from "./platform/index.ts";
import type { UpgradeProgress } from "./progress.ts";
import { slotArtifactPath } from "./txn/fileEffects.ts";
import { recordReconcile, type ProvenanceJournal } from "./provenance/journal.ts";
import { finishUpgradeOutcome } from "./upgrade/outcome.ts";
import { retireReason } from "./upgrade/retire.ts";
import { buildStatusReport, type StatusReport } from "./status/report.ts";
import { persistReport, loadLastReport, type ReportRead } from "./status/reportStore.ts";

export interface CreateUpgraderOptions extends UpgraderConfig {
  clock?: Clock;
  /** Reports who owns this install; default: we own it. */
  installOwnership?: () => "self" | "managed-elsewhere";
  /** Optional host semantic gate; a string result refuses the transition. */
  checkCompatibility?: (from: string, to: string) => Promise<string | null>;
  /**
   * Progress for a host that wants to show something while this runs.
   *
   * Without it, a long upgrade is indistinguishable from a hung one, and the
   * user's remedy for "hung" is to kill the process mid-transaction. Purely
   * observational: never awaited for control flow, and a throwing sink must
   * not fail the upgrade.
   */
  onProgress?: (progress: UpgradeProgress) => void;
  /**
   * The OS-lifecycle read-back surfaces the app's platform adapter
   * declares (host_lifecycle_converged, design-v1 §L3). Each surface is
   * read during readback; convergence requires it to reference the
   * artifact being promoted. Surfaces NOT declared here are refused —
   * an app can only vouch for surfaces it actually ships.
   */
  lifecycleSurfaces?: ReadbackSurface[];
  /**
   * M6 provenance journal (L5): every reconcile that reaches the transaction
   * records WHO drove it (who/carrier/version), write-ahead. Local
   * auto-updates use `provenanceIdentity` (default: the local operator).
   */
  provenance?: ProvenanceJournal;
  /** Identity recorded for reconciles that carry none (local auto-update). */
  provenanceIdentity?: ProvenanceIdentity;
}

export function createUpgrader(opts: CreateUpgraderOptions): Upgrader {
  const clock = opts.clock ?? systemClock;
  const effects = fileEffects(opts.stateDir);
  const ownership = opts.installOwnership ?? ((): "self" => "self");

  // The last predicate evidence, captured for the promote report (the
  // engine only carries pass/fail; the report needs the real results).
  let lastEvidence: ProcessEvidence | null = null;
  let lastLifecycle: PredicateResult | null = null;
  /** The report state of the last promote (status + retirement read it). */
  let lastReport: ReportRead | null = null;
  let reportLoaded = false;
  /** Load the persisted report once — a restart must not erase a real observation. */
  async function currentReport(): Promise<ReportRead> {
    if (!reportLoaded) {
      lastReport = await loadLastReport(opts.stateDir);
      reportLoaded = true;
    }
    return lastReport ?? { kind: "genesis" };
  }

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

  async function readState(): Promise<TxnState> {
    const slots = await effects.slots.slotVersions();
    const intents = (await effects.journal.readAll()).map((e) => e.intent);
    return {
      phase: intents.at(-1) ?? "idle",
      stableVersion: slots.stable ?? "0.0.0",
      experimentVersion: slots.experiment,
      rollbackReason: null,
    };
  }

  /** Report a stage. Observational only: a broken sink cannot break upgrades. */
  function reportStage(progress: UpgradeProgress): void {
    try {
      opts.onProgress?.(progress);
    } catch {
      // a host's progress bar must never be able to fail an upgrade
    }
  }

  async function notify(kind: Parameters<UpgraderConfig["notificationSink"]>[0]["kind"], detail: Record<string, string>): Promise<void> {
    await opts.notificationSink({ kind, detail });
  }

  /** Gates 1-7. `consented` = the user approved THIS version (the confirm was
   * shown and answered) — the policy gate is skipped, everything else stands. */
  async function run(
    pick: (current: string) => Promise<Release | null>,
    consented = false,
    provenance: ProvenanceIdentity | null = null,
  ): Promise<UpgradeOutcome> {
    const owner = ownership();
    if (owner === "managed-elsewhere") {
      await notify("held", { reason: "managed-elsewhere" });
      return { result: "held", reason: "this install is managed by another manager; it does not upgrade itself" };
    }

    const lock = await acquireUpgradeLock(opts.stateDir, clock.nowMs());
    try {
      await engine.recover(); // finish or undo anything a previous crash left

      const current = (await readState()).stableVersion;
      reportStage({ stage: "checking" });
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
      reportStage({ stage: "downloading", version: release.version });
      const bytes = await downloadVerified(release, {
        clock,
        resumeDir: path.join(opts.stateDir, "incoming"),
        onProgress: (downloaded, total) =>
          reportStage({ stage: "downloading", version: release.version, downloaded, total }),
      });
      reportStage({ stage: "verifying", version: release.version });

      reportStage({ stage: "staging", version: release.version });
      const bytesRef = await materializeArtifact(opts.stateDir, bytes);

      // M6 provenance: record WHO drove this reconcile, write-ahead of the txn.
      if (opts.provenance) {
        await recordReconcile(opts.provenance, provenance ?? opts.provenanceIdentity, release.version);
      }

      reportStage({ stage: "handing-over", version: release.version });
      const outcome = await engine.upgrade({ version: release.version, bytesRef });
      const finished = await finishUpgradeOutcome(outcome, {
        notify,
        reportStage,
        targetVersion: release.version,
        declaredSurfaces: (opts.lifecycleSurfaces ?? []).length,
        nowMs: clock.nowMs(),
        evidence: lastEvidence,
        lifecycle: lastLifecycle,
      });
      if (finished.report !== null) {
        lastReport = { kind: "observed", report: finished.report };
        reportLoaded = true;
        await persistReport(opts.stateDir, finished.report);
      }
      return finished.outcome;
    } finally {
      await lock.release();
    }
  }

  return {
    async check(): Promise<{ current: string; target: string | null }> {
      const current = (await readState()).stableVersion;
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

    async upgradeTo(version: string, opts2?: { consented?: boolean; provenance?: ProvenanceIdentity }): Promise<UpgradeOutcome> {
      return run(
        async (current) =>
          opts.source.fetchRelease(version, {
            currentVersion: current,
            platformKey: platformOpsFor().platformKey(),
          }),
        opts2?.consented === true,
        opts2?.provenance ?? null,
      );
    },

    async retireLegacyManager(): Promise<"retired" | { held: string }> {
      return retireReason(await currentReport());
    },

    async rollback(reason: string): Promise<"rolled-back" | { held: string }> {
      const lock = await acquireUpgradeLock(opts.stateDir, clock.nowMs());
      try {
        // Gate on the action's nature: settling K's own in-flight
        // transaction is ALWAYS allowed (a held mid-transaction is a
        // brick); only NEW modification of a machine AT REST managed
        // elsewhere is refused.
        const last = (await effects.journal.readAll()).at(-1)?.intent;
        const inFlight = last !== undefined && last !== "idle" && last !== "promoted";
        if (!inFlight && ownership() === "managed-elsewhere") {
          await notify("held", { reason: "managed-elsewhere" });
          return { held: "this install is managed by another manager; it does not roll itself back" };
        }
        await engine.recover();
        await effects.slots.clearExperiment();
        await notify("rolled-back", { reason });
        return "rolled-back";
      } finally {
        await lock.release();
      }
    },

    async state(): Promise<TxnState> {
      return readState();
    },

    async status(): Promise<StatusReport> {
      return buildStatusReport({
        state: await readState(),
        lastReport: await currentReport(),
        policy: opts.policy,
        provenance: opts.provenance ? await opts.provenance.read() : null,
      });
    },
  };
}
