/**
 * Crash-point enumerator (harness-design §1.4) — the load-bearing piece.
 *
 * Coverage is GENERATED from the engine's transition table, never hand-listed.
 * For every transition we crash at each durability-relevant instant:
 *
 *   before-journal : intent not yet durable -> recovery must see the OLD phase
 *   after-journal  : intent durable, action NOT done -> recovery must finish or undo
 *   after-action   : action done, before the next intent -> same obligation
 *
 * "after-journal" is the interesting one: it is precisely the window where a
 * naive implementation loses track of what it was doing. Enumeration makes it
 * impossible to forget, and the completeness tooth makes it impossible to add
 * a transition without covering it.
 */
import { TRANSITIONS, type Transition } from "../../../core/src/txn/transitions.ts";

export type CrashInstant = "before-journal" | "after-journal" | "after-action";

export const CRASH_INSTANTS: readonly CrashInstant[] = [
  "before-journal",
  "after-journal",
  "after-action",
];

export interface CrashPoint {
  /** Stable id, e.g. "staged->handing-over@after-journal". */
  id: string;
  transition: Transition;
  instant: CrashInstant;
}

/** The full matrix: every transition x every crash instant. */
export function enumerateCrashPoints(
  transitions: readonly Transition[] = TRANSITIONS,
): CrashPoint[] {
  const points: CrashPoint[] = [];
  for (const transition of transitions) {
    for (const instant of CRASH_INSTANTS) {
      points.push({
        id: `${transition.from}->${transition.to}@${instant}`,
        transition,
        instant,
      });
    }
  }
  return points;
}

/**
 * Completeness accounting: the matrix must cover every transition in the
 * table. Returns transitions that have no crash point (should always be
 * empty; the tooth asserts it).
 */
export function uncoveredTransitions(
  points: readonly CrashPoint[],
  transitions: readonly Transition[] = TRANSITIONS,
): Transition[] {
  const covered = new Set(points.map((p) => `${p.transition.from}->${p.transition.to}`));
  return transitions.filter((t) => !covered.has(`${t.from}->${t.to}`));
}

/** Crash points whose instant is not one of the declared instants (guards typos). */
export function malformedPoints(points: readonly CrashPoint[]): CrashPoint[] {
  return points.filter((p) => !CRASH_INSTANTS.includes(p.instant));
}
