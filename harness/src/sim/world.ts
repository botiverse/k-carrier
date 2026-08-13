import { checkInvariants, type WorldSnapshot } from "../../../core/src/invariants.ts";
import type {
  HostAdapter,
  ProcessEvidence,
  Slot,
} from "../../../core/src/lifecycle/hostAdapter.ts";
import type { TxnEffects } from "../../../core/src/txn/effects.ts";
import type { JournalEntry, TxnPhase } from "../../../core/src/txn/state.ts";
import type { FaultCoverage } from "./scheduler.ts";
import { EffectRuntime } from "./effectRuntime.ts";
import { SimulationError } from "./error.ts";

export type SimulationMutation =
  | "drop-journal-durability"
  | "skip-stable-stop"
  | "skip-terminal-resume";

interface PendingJournalWrite {
  entry: JournalEntry;
  shape: "complete" | "partial" | "reordered";
}

interface LiveProcess {
  slot: Slot;
  pid: number;
  startId: string;
  version: string;
}

export interface SimWorldOptions {
  seed: number;
  mutation?: SimulationMutation;
  faults?: boolean;
}

/**
 * Persistent, in-memory machine used by DST. It implements the production
 * seams rather than a second transaction engine: UpgradeEngine is still the
 * thing being exercised.
 */
export class SimWorld {
  readonly mutation: SimulationMutation | undefined;
  private readonly runtime: EffectRuntime;

  private readonly durableJournal: JournalEntry[] = [];
  private pendingJournal: PendingJournalWrite | null = null;
  private readonly slots: Record<Slot, string | null> = {
    stable: "1.0.0",
    experiment: null,
  };
  private live: LiveProcess[] = [
    { slot: "stable", pid: 1000, startId: "incarnation-1", version: "1.0.0" },
  ];
  private phase: TxnPhase = "idle";
  private quiesced = false;
  private nextPid = 1001;
  private nextIncarnation = 2;

  constructor(opts: SimWorldOptions) {
    this.mutation = opts.mutation;
    this.runtime = new EffectRuntime(opts.seed, opts.faults ?? true, (name) =>
      this.assertInvariants(name),
    );
  }

  get coverage(): FaultCoverage {
    return this.runtime.coverage;
  }

  get trace(): string[] {
    return this.runtime.trace;
  }

  get currentPhase(): TxnPhase {
    return this.phase;
  }

  get isQuiesced(): boolean {
    return this.quiesced;
  }

  get durableEntries(): readonly JournalEntry[] {
    return this.durableJournal;
  }

  get slotState(): Readonly<Record<Slot, string | null>> {
    return this.slots;
  }

  get liveProcesses(): readonly LiveProcess[] {
    return this.live;
  }

  get clock() {
    return this.runtime.clock;
  }

  readonly effects: TxnEffects = {
    journal: {
      appendAndSync: async (entry) => {
        await this.runtime.effect(
          `journal.write.${entry.intent}`,
          "journal-write",
          () => {
            this.pendingJournal = { entry: cloneEntry(entry), shape: "complete" };
          },
          {
            partial: () => {
              this.pendingJournal = { entry: cloneEntry(entry), shape: "partial" };
            },
            reorder: () => {
              this.pendingJournal = { entry: cloneEntry(entry), shape: "reordered" };
            },
          },
        );
        await this.runtime.effect(`journal.fsync.${entry.intent}`, "journal-fsync", () => {
          const pending = this.pendingJournal;
          if (pending === null || pending.shape !== "complete") {
            throw new SimulationError(
              "effect-failure",
              `journal.fsync.${entry.intent}`,
              `SIM_EFFECT_FAIL: journal.fsync.${entry.intent}: volatile tail is ${pending?.shape ?? "missing"}; refusing to acknowledge fsync`,
            );
          }
          if (this.mutation !== "drop-journal-durability") {
            this.durableJournal.push(cloneEntry(pending.entry));
            this.phaseAfterDurableIntent(pending.entry.intent);
          }
          this.pendingJournal = null;
        });
      },
      readAll: async () =>
        this.runtime.effect("journal.read-all", "journal-read", () =>
          this.durableJournal.map(cloneEntry),
        ),
    },
    slots: {
      stageExperiment: async (artifact) => {
        await this.runtime.effect("slots.stage-experiment", "slot-write", () => {
          this.slots.experiment = artifact.version;
          this.phase = "staged";
        });
      },
      slotVersions: async () =>
        this.runtime.effect("slots.read-versions", "slot-read", () => ({ ...this.slots })),
      promoteExperiment: async () => {
        await this.runtime.effect("slots.promote-experiment", "slot-write", () => {
          if (this.slots.experiment !== null) {
            this.slots.stable = this.slots.experiment;
            this.slots.experiment = null;
            this.live = this.live.map((process) =>
              process.slot === "experiment" ? { ...process, slot: "stable" } : process,
            );
          }
          this.phase = "promoted";
        });
      },
      clearExperiment: async () => {
        await this.runtime.effect("slots.clear-experiment", "slot-write", () => {
          this.slots.experiment = null;
          this.live = this.live.filter((process) => process.slot !== "experiment");
          this.phase = "rolled-back";
        });
      },
    },
  };

  readonly host: HostAdapter = {
    quiesce: async () => {
      await this.runtime.effect("host.quiesce", "host", () => {
        this.quiesced = true;
      });
    },
    stop: async (slot) => {
      await this.runtime.effect(`host.stop.${slot}`, "host", () => {
        if (slot === "stable" && this.mutation === "skip-stable-stop") return;
        this.live = this.live.filter((process) => process.slot !== slot);
      });
    },
    start: async (slot) => {
      await this.runtime.effect(`host.start.${slot}`, "host", () => {
        const version = this.slots[slot];
        if (version === null) throw new Error(`cannot start empty ${slot} slot`);
        if (this.live.some((process) => process.slot === slot)) return; // idempotent
        this.live.push({
          slot,
          version,
          pid: this.nextPid++,
          startId: `incarnation-${this.nextIncarnation++}`,
        });
      });
    },
    healthProbe: async (): Promise<ProcessEvidence> =>
      this.runtime.effect("host.health-probe", "host", () => {
        if (this.live.length === 0) throw new Error("no live process");
        const process = this.live.at(-1)!;
        return {
          version: process.version,
          pid: process.pid,
          startId: process.startId,
        };
      }),
    resume: async () => {
      await this.runtime.effect("host.resume", "host", () => {
        if (this.mutation !== "skip-terminal-resume") this.quiesced = false;
      });
    },
  };

  async evaluatePredicates(refuse: boolean): Promise<string | null> {
    return this.runtime.effect("predicate.evaluate", "predicate", () =>
      refuse ? "seed selected the rollback scenario" : null,
    );
  }

  /** A process crash discards every non-fsync'd fragment and pending timer. */
  reboot(reason: string): void {
    const tail = this.pendingJournal?.shape ?? "none";
    this.runtime.reboot(reason, tail);
    this.pendingJournal = null;
    this.assertInvariants("reboot");
  }

  snapshot(): WorldSnapshot {
    return {
      phase: this.phase,
      slots: { ...this.slots },
      liveProcesses: this.live.map((process) => ({ ...process })),
      journalIntents: this.durableJournal.map((entry) => entry.intent),
      workloadDigest: "workload-v1",
      priorIncarnationStartId: "incarnation-1",
      installOwnership: "self",
    };
  }

  isSettled(): boolean {
    const terminal = this.phase === "promoted" || this.phase === "rolled-back";
    if (!terminal || this.slots.experiment !== null || this.quiesced) return false;
    return (
      this.live.length === 1 &&
      this.live[0]!.slot === "stable" &&
      this.live[0]!.version === this.slots.stable
    );
  }

  terminalProblem(): string | null {
    if (this.phase !== "promoted" && this.phase !== "rolled-back") {
      return `phase ${this.phase} is not terminal`;
    }
    if (this.slots.experiment !== null) return `terminal phase left experiment ${this.slots.experiment}`;
    if (this.quiesced) return "terminal phase left workloads quiesced";
    if (this.live.length !== 1) return `terminal phase has ${this.live.length} live processes`;
    const live = this.live[0]!;
    if (live.slot !== "stable" || live.version !== this.slots.stable) {
      return `terminal live process is ${live.slot}@${live.version}, stable is ${this.slots.stable}`;
    }
    return null;
  }

  private phaseAfterDurableIntent(intent: TxnPhase): void {
    // staged/promoted/rolled-back are intents whose named slot action has not
    // happened yet. The other intents describe an entered control phase.
    if (intent === "handing-over" || intent === "running-experiment" || intent === "readback") {
      this.phase = intent;
    }
  }

  private assertInvariants(effectName: string): void {
    const violations = checkInvariants(this.snapshot());
    if (violations.length > 0) {
      throw new SimulationError(
        "invariant",
        effectName,
        `SIM_INVARIANT: after ${effectName}: ${violations
          .map((violation) => `${violation.invariantId}: ${violation.reason}`)
          .join("; ")}`,
      );
    }
  }
}

function cloneEntry(entry: JournalEntry): JournalEntry {
  return { ...entry, detail: { ...entry.detail } };
}
