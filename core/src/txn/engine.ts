/**
 * Upgrade transaction engine — pure state machine over TxnEffects +
 * HostAdapter (sim-first: zero direct IO/time/randomness; see effects.ts).
 *
 * Invariants (each is a harness tooth):
 *  - WAL: intent is journaled+fsync'd BEFORE the action it names.
 *  - Crash anywhere -> recover() lands on stable-running or completes the
 *    transition, decided by journal replay. Never dual-run, never bricked.
 *  - Promote only after the caller-supplied predicate evaluation passed.
 *  - Rollback is always available until promote; its reason is journaled.
 */
import type { HostAdapter, ProcessEvidence } from "../lifecycle/hostAdapter.ts";
import type { TxnEffects } from "./effects.ts";
import type { JournalEntry, TxnPhase } from "./state.ts";
import { STATE_FORMAT_VERSION } from "./state.ts";
import type { Clock } from "../clock.ts";

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
}

export type EngineOutcome =
  | { result: "promoted"; version: string }
  | { result: "rolled-back"; reason: string }
  | { result: "up-to-date" };

export class UpgradeEngine {
  private readonly deps: EngineDeps;
  private seq = 0;

  constructor(deps: EngineDeps) {
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
    const entries = await this.deps.effects.journal.readAll();
    const last = entries.at(-1);
    this.seq = (last?.seq ?? -1) + 1;
    if (!last) return; // fresh install, stable running

    const version = (await this.deps.effects.slots.slotVersions()).experiment;
    switch (last.intent) {
      case "idle":
      case "promoted":
      case "rolled-back":
        return; // terminal states; nothing in flight
      case "staged":
        // Download completed but handover never started: cheap undo.
        await this.rollbackTo("crash before handover", { skipHostRestart: true });
        return;
      case "handing-over":
      case "running-experiment":
      case "readback": {
        // We may have died with the experiment (partially) live. Fail closed:
        // stop whatever runs, restore stable, resume workloads.
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

    await this.journal("staged", { version: target.version });
    await this.deps.effects.slots.stageExperiment(target);

    await this.journal("handing-over", { version: target.version });
    await this.deps.host.quiesce();
    await this.deps.host.stop("stable");
    await this.deps.host.start("experiment");

    await this.journal("running-experiment", { version: target.version });
    let evidence: ProcessEvidence;
    try {
      evidence = await this.deps.host.healthProbe();
    } catch (err) {
      return this.rollbackOutcome(`experiment probe failed: ${(err as Error).message}`);
    }

    await this.journal("readback", { version: target.version });
    const refusal = await this.deps.evaluatePredicates(evidence, target.version);
    if (refusal !== null) {
      return this.rollbackOutcome(`predicates refused: ${refusal}`);
    }

    await this.journal("promoted", { version: target.version });
    await this.deps.effects.slots.promoteExperiment();
    await this.deps.host.resume();
    return { result: "promoted", version: target.version };
  }

  private async rollbackOutcome(reason: string): Promise<EngineOutcome> {
    await this.rollbackTo(reason);
    return { result: "rolled-back", reason };
  }

  private async rollbackTo(reason: string, opts: { skipHostRestart?: boolean } = {}): Promise<void> {
    await this.journal("rolled-back", { reason });
    if (!opts.skipHostRestart) {
      // Stop whatever may be running (either slot), restore stable, resume.
      await this.deps.host.stop("experiment");
      await this.deps.host.start("stable");
      await this.deps.host.resume();
    }
    await this.deps.effects.slots.clearExperiment();
  }
}
