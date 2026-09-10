/**
 * Upgrade transaction engine — pure state machine over TxnEffects +
 * HostAdapter (sim-first: zero direct IO/time/randomness; see effects.ts).
 *
 * Invariants (each is a harness tooth):
 *  - WAL: intent is journaled+fsync'd BEFORE the action it names.
 *  - Crash anywhere -> recover() lands on stable-running or completes the
 *    transition, decided by journal replay. Never dual-run, never bricked.
 *  - Promote only after the caller-supplied predicate evaluation passed.
 *  - Readback is bound to a NEW incarnation: the startId probed before
 *    handover is journaled, and evidence carrying it again is refused.
 *  - Rollback is always available until promote; its reason is journaled.
 */
import type { HostAdapter, ProcessEvidence } from "../lifecycle/hostAdapter.ts";
import type { TxnEffects } from "./effects.ts";
import type { JournalEntry, TxnPhase } from "./state.ts";
import { STATE_FORMAT_VERSION } from "./state.ts";
import type { Clock } from "../clock.ts";
import { HostCallTimeout, HostCallUncertain, DEFAULT_HOST_CALL_BUDGET_MS } from "./hostCallBudget.ts";


export interface EngineDeps {
  effects: TxnEffects;
  host: HostAdapter;
  clock: Clock;
  /**
   * Evaluate convergence for the freshly started experiment process.
   * Returns null when converged; otherwise a human-readable refusal that
   * becomes the rollback reason. (Full ConvergenceReport wiring lands with
   * converge/; the engine only cares about pass/fail + reason.)
   */
  evaluatePredicates: (evidence: ProcessEvidence, targetVersion: string) => Promise<string | null>;
  /**
   * Budget for a single host call (quiesce/stop/start/probe).
   *
   * A host that HANGS is worse than one that crashes: nothing is journaled,
   * the lock stays held by a process that is still alive (so stale-lock
   * takeover does not apply), and every later attempt queues behind it
   * forever. That is the "wedged half-way" failure, and it is the one an
   * updater is least able to explain afterwards.
   *
   * Default 120s: long enough for a real service to drain sessions on a busy
   * machine, short enough that a wedge is reported the same day it happens.
   */
  hostCallBudgetMs?: number;
}

export type EngineOutcome =
  | { result: "promoted"; version: string }
  | { result: "rolled-back"; reason: string }
  | { result: "up-to-date" };

export class UpgradeEngine {
  private readonly deps: EngineDeps;
  private seq = 0;

  constructor(deps: EngineDeps) {
    const budget = deps.hostCallBudgetMs ?? DEFAULT_HOST_CALL_BUDGET_MS;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647) throw new Error("invalid host call budget");
    this.deps = deps;
  }

  private async journal(intent: TxnPhase, detail: Record<string, string> = {}): Promise<void> {
    const entry: JournalEntry = {
      seq: this.seq++,
      timestampMs: this.deps.clock.nowMs(),
      intent,
      detail: { ...detail, formatVersion: String(STATE_FORMAT_VERSION) },
    };
    await this.deps.effects.journal.appendAndSync(entry);
  }

  /**
   * Replay the journal and finish or undo whatever was in flight.
   * Must be called before upgrade() on every process start.
   */
  async recover(): Promise<void> {
    if (this.deps.host.fence) await this.withBudget("fence", () => this.deps.host.fence!());
    const entries = await this.deps.effects.journal.readAll();
    const last = entries.at(-1);
    this.seq = (last?.seq ?? -1) + 1;
    if (!last) return; // fresh install, stable running

    const version = (await this.deps.effects.slots.slotVersions()).experiment;
    switch (last.intent) {
      case "idle":
        return;
      case "promoted":
        // WAL redo: the intent is durable but its action may not have run
        // (crash in the after-journal window). Completing it is idempotent —
        // promoteExperiment on an already-promoted world is a no-op because
        // the experiment slot is empty.
        await this.deps.effects.slots.promoteExperiment();
        // resume is part of the terminal action too. A crash after promote()
        // but before resume() used to leave the service alive and its hosted
        // work permanently parked; DST found this exact effect boundary.
        await this.withBudget("resume", () => this.deps.host.resume());
        return;
      case "rolled-back":
        // The terminal journal entry is WAL intent, not proof that the host
        // restore ran. Redo the whole idempotent rollback action: a crash
        // immediately after journaling `rolled-back` may still have the
        // experiment process live and workloads parked.
        await this.withBudget("stop", () => this.deps.host.stop("experiment"));
        await this.withBudget("start", () => this.deps.host.start("stable"));
        await this.withBudget("resume", () => this.deps.host.resume());
        await this.deps.effects.slots.clearExperiment();
        return;
      case "staged":
        // Download completed but handover never started: cheap undo.
        await this.rollbackTo("crash before handover", { skipHostRestart: true });
        return;
      case "handing-over":
      case "running-experiment":
      case "readback": {
        // Runner death before the commit intent always undoes the attempt.
        // A healthy candidate does not authorize a successor to commit it.
        await this.rollbackTo(`crash during ${last.intent}` + (version ? ` (experiment ${version})` : ""));
        return;
      }
      default: {
        // Unknown intent => journal written by a NEWER core. Fail closed.
        throw new Error(
          `journal intent ${JSON.stringify(last.intent)} is not understood by this core (state format newer than binary); refusing to act`,
        );
      }
    }
  }

  /** Full transactional upgrade to targetVersion via a pre-verified artifact. */
  async upgrade(target: { version: string; bytesRef: string }): Promise<EngineOutcome> {
    const versions = await this.deps.effects.slots.slotVersions();
    if (versions.stable === target.version) return { result: "up-to-date" };

    // Record the incarnation this upgrade replaces, before anything on disk
    // changes. A probe that FAILS means nothing is live to compare against (a
    // stopped service is still upgradable); a probe that WEDGES is not
    // information and is let out, exactly as for the readback probe below.
    let prior: ProcessEvidence | null = null;
    try {
      prior = await this.withBudget("healthProbe", () => this.deps.host.healthProbe());
    } catch (err) {
      if (err instanceof HostCallUncertain) throw err;
      prior = null;
    }

    await this.journal("staged", { version: target.version });
    await this.deps.effects.slots.stageExperiment(target);

    // The external runner survives normal service replacement.
    await this.journal("handing-over", { version: target.version, ...(prior ? { priorStartId: prior.startId } : {}) });
    await this.withBudget("quiesce", () => this.deps.host.quiesce());
    await this.withBudget("stop", () => this.deps.host.stop("stable"));
    await this.withBudget("start", () => this.deps.host.start("experiment"));

    await this.journal("running-experiment", { version: target.version });
    let evidence: ProcessEvidence;
    try {
      evidence = await this.withBudget("healthProbe", () => this.deps.host.healthProbe());
    } catch (err) {
      // A probe that FAILED is information: the host answered "not healthy",
      // so rolling back (which calls stop/start/resume) is sound. A probe that
      // WEDGED is not information -- we do not know what the host is doing, and
      // issuing more host calls to a host that never answered the last one is
      // how a stuck upgrade becomes two live incarnations. Let it out; the
      // journal keeps the in-flight phase and the next start resolves it from
      // evidence.
      if (err instanceof HostCallUncertain) throw err;
      return this.rollbackOutcome(`experiment probe failed: ${(err as Error).message}`);
    }

    await this.journal("readback", { version: target.version });
    // The same startId after stop/start means the old process answered: it
    // was never stopped, or the probe served cached evidence. A version
    // string alone cannot tell those apart; the incarnation identity can.
    if (prior !== null && evidence.startId === prior.startId) {
      return this.rollbackOutcome(
        `live process is still the pre-upgrade incarnation (startId ${evidence.startId}); the old service was not replaced`,
      );
    }
    const refusal = await this.withBudget("readback", () => this.deps.evaluatePredicates(evidence, target.version));
    if (refusal !== null) {
      return this.rollbackOutcome(`predicates refused: ${refusal}`);
    }

    await this.journal("promoted", { version: target.version });
    await this.deps.effects.slots.promoteExperiment();
    await this.withBudget("resume", () => this.deps.host.resume());
    return { result: "promoted", version: target.version };
  }

  /**
   * Bound a host call. On expiry we do NOT pretend the call failed cleanly:
   * a pending promise cannot be cancelled in JS, so the host may still be
   * mid-operation. The transaction gives up instead of issuing further host
   * calls it cannot reason about, and the journal records why. Recovery is
   * the next process start, which replays the durable commit or restores stable.
   */
  private async withBudget<T>(label: string, call: () => Promise<T>): Promise<T> {
    const budgetMs = this.deps.hostCallBudgetMs ?? DEFAULT_HOST_CALL_BUDGET_MS;
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_resolve, reject) => {
          cancel = this.deps.clock.after(budgetMs, () => {
            reject(new HostCallTimeout(label, budgetMs));
          });
        }),
      ]);
    } finally {
      cancel?.();
    }
  }

  private async rollbackOutcome(reason: string): Promise<EngineOutcome> {
    await this.rollbackTo(reason);
    return { result: "rolled-back", reason };
  }

  private async rollbackTo(reason: string, opts: { skipHostRestart?: boolean } = {}): Promise<void> {
    await this.journal("rolled-back", { reason });
    if (!opts.skipHostRestart) {
      // Stop whatever may be running (either slot), restore stable, resume.
      await this.withBudget("stop", () => this.deps.host.stop("experiment"));
      await this.withBudget("start", () => this.deps.host.start("stable"));
      await this.withBudget("resume", () => this.deps.host.resume());
    }
    await this.deps.effects.slots.clearExperiment();
  }
}
