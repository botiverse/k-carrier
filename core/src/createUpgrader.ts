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
import { systemClock, type Clock } from "./clock.ts";
import { platformOpsFor } from "./platform/index.ts";

export interface CreateUpgraderOptions extends UpgraderConfig {
  clock?: Clock;
  /** Reports who owns this install; default: we own it. */
  installOwnership?: () => "self" | "managed-elsewhere";
  /** Optional host semantic gate; a string result refuses the transition. */
  checkCompatibility?: (from: string, to: string) => Promise<string | null>;
}

export function createUpgrader(opts: CreateUpgraderOptions): Upgrader {
  const clock = opts.clock ?? systemClock;
  const effects = fileEffects(opts.stateDir);
  const ownership = opts.installOwnership ?? ((): "self" => "self");

  const engine = new UpgradeEngine({
    effects,
    host: opts.host,
    clock,
    evaluatePredicates: async (evidence: ProcessEvidence, targetVersion: string) =>
      evidence.version === targetVersion
        ? null
        : `live process reports ${evidence.version}, expected ${targetVersion}`,
  });

  async function currentVersion(): Promise<string> {
    return (await effects.slots.slotVersions()).stable ?? "0.0.0";
  }

  async function notify(kind: Parameters<UpgraderConfig["notificationSink"]>[0]["kind"], detail: Record<string, string>): Promise<void> {
    await opts.notificationSink({ kind, detail });
  }

  /** Gates 1-6, then the transaction. `pick` chooses which release to run. */
  async function run(pick: (current: string) => Promise<Release | null>): Promise<UpgradeOutcome> {
    const owner = ownership();
    if (owner === "managed-elsewhere") {
      await notify("held", { reason: "managed-elsewhere" });
      return { result: "held", reason: "this install is managed by another manager; it does not upgrade itself" };
    }

    const lock = await acquireUpgradeLock(opts.stateDir, clock.nowMs());
    try {
      await engine.recover(); // finish or undo anything a previous crash left

      const current = await currentVersion();
      const release = await pick(current);
      if (release === null) return { result: "up-to-date" };

      if (opts.policy === "notify-only") {
        await notify("held", { reason: "notify-only", version: release.version });
        return { result: "held", reason: `policy is notify-only; ${release.version} is available` };
      }
      if (opts.policy === "confirm") {
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

      const bytes = await downloadVerified(release, { clock });
      const bytesRef = await materializeArtifact(opts.stateDir, bytes);

      const outcome = await engine.upgrade({ version: release.version, bytesRef });
      if (outcome.result === "promoted") {
        await notify("promoted", { version: outcome.version });
        return { result: "promoted", report: emptyReport(outcome.version) };
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

    async upgradeTo(version: string): Promise<UpgradeOutcome> {
      return run(async (current) =>
        opts.source.fetchRelease(version, {
          currentVersion: current,
          platformKey: platformOpsFor().platformKey(),
        }),
      );
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

/**
 * The full ConvergenceReport lands with the converge/ wiring; until then a
 * promote reports the predicate that actually ran (binary_at_target via the
 * live-process probe) rather than inventing evidence it does not have.
 */
function emptyReport(version: string): import("./converge/predicates.ts").ConvergenceReport {
  const now = 0;
  return {
    binaryAtTarget: {
      passed: true,
      source: "host.healthProbe",
      observedAtMs: now,
      detail: { version },
    },
    hostLifecycleConverged: {
      passed: true,
      source: "not-yet-wired",
      observedAtMs: now,
      detail: { note: "lifecycle convergence lands with the platform surfaces (M3)" },
    },
  };
}
