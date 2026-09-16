import type { Clock } from "../../../core/src/clock.ts";
import { SimulationError } from "./error.ts";
import {
  FaultScheduler,
  type EffectKind,
  type FaultCoverage,
} from "./scheduler.ts";

interface Timer {
  id: number;
  dueMs: number;
  fn: () => void;
  canceled: boolean;
}

export interface VolatileFaultHooks {
  partial?: () => void;
  reorder?: () => void;
}

/** Seeded scheduling and virtual time, separated from the simulated machine. */
export class EffectRuntime {
  readonly trace: string[] = [];
  readonly clock: Clock;
  private readonly scheduler: FaultScheduler;
  private now = 1_000;
  private nextTimerId = 1;
  private readonly timers: Timer[] = [];
  private effectNumber = 0;
  private readonly assertInvariants: (name: string) => void;

  constructor(seed: number, faults: boolean, assertInvariants: (name: string) => void) {
    this.scheduler = new FaultScheduler(seed, faults);
    this.assertInvariants = assertInvariants;
    this.clock = {
      nowMs: () => this.now,
      after: (ms, fn) => {
        const timer: Timer = {
          id: this.nextTimerId++,
          dueMs: this.now + ms,
          fn,
          canceled: false,
        };
        this.timers.push(timer);
        return () => {
          timer.canceled = true;
        };
      },
    };
  }

  get coverage(): FaultCoverage {
    return { ...this.scheduler.coverage };
  }

  async effect<T>(
    name: string,
    kind: EffectKind,
    apply: () => T,
    volatile: VolatileFaultHooks = {},
  ): Promise<T> {
    const decision = this.scheduler.decide(kind);
    this.effectNumber += 1;
    this.trace.push(`${this.effectNumber}:${name}:${decision}`);

    if (decision === "delay") this.advance(this.scheduler.delayMs());
    if (decision === "partial-write") {
      volatile.partial?.();
      this.assertInvariants(name);
      throw new SimulationError("crash", name, `SIM_CRASH_PARTIAL: ${name}`);
    }
    if (decision === "reorder-volatile") {
      volatile.reorder?.();
      this.assertInvariants(name);
      throw new SimulationError(
        "effect-failure",
        name,
        `SIM_EFFECT_FAIL: ${name}: volatile journal fragments reordered before fsync`,
      );
    }
    if (decision === "crash-before") {
      this.assertInvariants(name);
      throw new SimulationError("crash", name, `SIM_CRASH_BEFORE: ${name}`);
    }
    if (decision === "fail-before") {
      this.assertInvariants(name);
      throw new SimulationError("effect-failure", name, `SIM_EFFECT_FAIL: ${name}: injected failure`);
    }

    const result = apply();
    this.assertInvariants(name);
    if (decision === "crash-after") {
      throw new SimulationError("crash", name, `SIM_CRASH_AFTER: ${name}`);
    }
    return result;
  }

  reboot(reason: string, volatileTail: string): void {
    this.trace.push(`reboot:${reason}:drop-tail=${volatileTail}`);
    for (const timer of this.timers) timer.canceled = true;
  }

  private advance(ms: number): void {
    this.now += ms;
    const due = this.timers
      .filter((timer) => !timer.canceled && timer.dueMs <= this.now)
      .toSorted((left, right) => left.dueMs - right.dueMs || left.id - right.id);
    for (const timer of due) {
      timer.canceled = true;
      timer.fn();
    }
  }
}
