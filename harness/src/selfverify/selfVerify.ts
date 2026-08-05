/**
 * Harness self-verification — M0's exit gate (harness-design §1.6).
 *
 * The harness must prove it can judge before it is allowed to judge anything.
 * Three samples, all required:
 *
 *   known-green    a correct world must pass          (no false alarms)
 *   known-red      a seeded defect must be caught     (it detects at all)
 *   adversarial    a world that satisfies the CHECKS while violating the
 *                  real oracle must STILL be caught   (it detects what the
 *                  author did not think to check)
 *
 * The third is the one that matters. Anyone can write a checker that passes
 * its own examples; the question is whether it survives something built
 * specifically to slip through it. Escapes found in the wild get added here
 * permanently, so the suite only ever gets harder.
 */
import {
  checkInvariants,
  workloadPreserved,
  type Invariant,
  type WorldSnapshot,
} from "../../../core/src/invariants.ts";

export type SampleVerdict = "caught" | "passed";

export interface SelfVerifyOutcome {
  knownGreen: SampleVerdict;
  knownRed: SampleVerdict;
  adversarial: SampleVerdict;
  /** True only when all three behaved as required. */
  qualified: boolean;
  detail: string[];
}

function healthyWorld(): WorldSnapshot {
  return {
    phase: "promoted",
    slots: { stable: "2.0.0", experiment: null },
    liveProcesses: [{ slot: "stable", pid: 7, startId: "s-7", version: "2.0.0" }],
    journalIntents: ["staged", "handing-over", "running-experiment", "readback", "promoted"],
    workloadDigest: "ledger:42:abc",
  };
}

/** A seeded defect the checks are explicitly designed to catch. */
function defectiveWorld(): WorldSnapshot {
  return {
    ...healthyWorld(),
    // promote completed but the experiment slot was never cleared
    slots: { stable: "2.0.0", experiment: "2.0.0" },
  };
}

/**
 * The adversarial sample: a world engineered to satisfy every structural
 * check while violating the real oracle.
 *
 * Here: the upgrade reports success, invariants about slots/journal/phase all
 * hold, and exactly one process is live — but that process is the OLD binary
 * (the new version never actually took over). Every "shape" check passes;
 * only comparing the live process against the version that was promoted
 * exposes it. This is the live-PID false-success family (Raft #5245).
 */
function adversarialWorld(): WorldSnapshot {
  return {
    phase: "promoted",
    slots: { stable: "2.0.0", experiment: null },
    // EVERY structural check passes: one live process, its version matches
    // the stable slot, journal complete, no leftover experiment slot.
    liveProcesses: [{ slot: "stable", pid: 7, startId: "s-BEFORE", version: "2.0.0" }],
    journalIntents: ["staged", "handing-over", "running-experiment", "readback", "promoted"],
    workloadDigest: "ledger:42:abc",
    // ...but this is the SAME incarnation that was live before the upgrade:
    // the service never restarted; it merely reports the new version string.
    priorIncarnationStartId: "s-BEFORE",
  };
}

/**
 * The oracle the adversarial sample violates: a promote means the service was
 * actually restarted onto the new bytes. A version STRING can be reported by
 * the old incarnation; only a fresh incarnation identity proves the restart.
 * Registered as a first-class invariant so this escape can never reopen.
 */
export const promotedVersionIsLive: Invariant = {
  id: "k.promoted-runs-a-fresh-incarnation",
  description: "after promote, the live incarnation is not the one that preceded the upgrade",
  check: (s) => {
    if (s.phase !== "promoted" || s.priorIncarnationStartId === undefined) return null;
    const stale = s.liveProcesses.filter((p) => p.startId === s.priorIncarnationStartId);
    return stale.length > 0
      ? `promoted ${s.slots.stable} but the live incarnation (startId ${s.priorIncarnationStartId}) is the pre-upgrade one — it reports the new version without having restarted`
      : null;
  },
};

export function runSelfVerification(invariants: readonly Invariant[]): SelfVerifyOutcome {
  const detail: string[] = [];

  const greenViolations = checkInvariants(healthyWorld(), invariants);
  const knownGreen: SampleVerdict = greenViolations.length === 0 ? "passed" : "caught";
  if (knownGreen === "caught") {
    detail.push(`known-green FALSE ALARM: ${greenViolations.map((v) => v.invariantId).join(", ")}`);
  }

  const redViolations = checkInvariants(defectiveWorld(), invariants);
  const knownRed: SampleVerdict = redViolations.length > 0 ? "caught" : "passed";
  if (knownRed === "passed") detail.push("known-red ESCAPED: seeded defect went undetected");

  const advViolations = checkInvariants(adversarialWorld(), invariants);
  const adversarial: SampleVerdict = advViolations.length > 0 ? "caught" : "passed";
  if (adversarial === "passed") {
    detail.push(
      "adversarial ESCAPED: a world that satisfies every structural check while running the OLD binary was judged healthy",
    );
  }

  // The workload oracle must also survive a faked-preservation attempt.
  const fakedPreservation = workloadPreserved(healthyWorld(), {
    ...healthyWorld(),
    workloadDigest: "ledger:0:reset",
  });
  if (fakedPreservation === null) detail.push("workload oracle ESCAPED: digest change went unnoticed");

  const qualified =
    knownGreen === "passed" &&
    knownRed === "caught" &&
    adversarial === "caught" &&
    fakedPreservation !== null;

  return { knownGreen, knownRed, adversarial, qualified, detail };
}
