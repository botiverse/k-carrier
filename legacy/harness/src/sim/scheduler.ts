import { SeededPrng } from "./prng.ts";

export type EffectKind =
  | "journal-write"
  | "journal-fsync"
  | "journal-read"
  | "slot-read"
  | "slot-write"
  | "host"
  | "predicate";

export type FaultDecision =
  | "none"
  | "delay"
  | "crash-before"
  | "crash-after"
  | "fail-before"
  | "partial-write"
  | "reorder-volatile";

/** Counts are part of every simulation receipt: coverage is observable. */
export type FaultCoverage = Record<FaultDecision, number>;

export function emptyCoverage(): FaultCoverage {
  return {
    none: 0,
    delay: 0,
    "crash-before": 0,
    "crash-after": 0,
    "fail-before": 0,
    "partial-write": 0,
    "reorder-volatile": 0,
  };
}

/**
 * Seeded fault scheduler. Every effect asks once; no effect is invisible to
 * the schedule. Journal writes additionally expose partial/reordered volatile
 * tails. Those tails are never allowed to cross a successful fsync barrier.
 */
export class FaultScheduler {
  private readonly prng: SeededPrng;
  private readonly enabled: boolean;
  readonly coverage = emptyCoverage();

  constructor(seed: number, enabled = true) {
    this.prng = new SeededPrng(seed);
    this.enabled = enabled;
  }

  decide(kind: EffectKind): FaultDecision {
    if (!this.enabled) {
      this.coverage.none += 1;
      return "none";
    }
    const roll = this.prng.below(100);
    let decision: FaultDecision;
    if (kind === "journal-write" && roll < 5) decision = "partial-write";
    else if (kind === "journal-write" && roll < 9) decision = "reorder-volatile";
    else if (roll < 16) decision = "crash-before";
    else if (roll < 23) decision = "crash-after";
    else if (roll < 29) decision = "fail-before";
    else if (roll < 39) decision = "delay";
    else decision = "none";
    this.coverage[decision] += 1;
    return decision;
  }

  delayMs(): number {
    return 1 + this.prng.below(50);
  }
}
