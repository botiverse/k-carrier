/**
 * Upgrade progress: what stage we are in, and how far the download got.
 *
 * WHY THIS IS NOT UI SUGAR. Between "start upgrading" and "done" there can be
 * a 150MB download, a file swap, a process restart and a probe — minutes on a
 * slow machine. With no signal, **"slow" and "hung" look identical from
 * outside**, so a user kills it, and a kill lands in the middle of a
 * transaction, which is the worst possible moment.
 *
 * The stages are NOT new vocabulary: they are the transaction's own phases,
 * exposed. If a stage here ever disagrees with the state machine, the state
 * machine is right and this is a bug.
 */
import type { TxnPhase } from "./txn/state.ts";

export type UpgradeStage =
  | "checking"      // asking the source what we should be on
  | "downloading"   // fetching bytes (carries downloaded/total when known)
  | "verifying"     // sha256 + size on the assembled artifact
  | "staging"       // writing the experiment slot
  | "handing-over"  // quiesce, stop, start — the live process changes
  | "probing"       // asking the new incarnation to prove itself
  | "promoted"      // experiment became stable
  | "rolled-back";  // experiment discarded, stable untouched

export interface UpgradeProgress {
  stage: UpgradeStage;
  /** Target version, once the source has told us. */
  version?: string;
  /**
   * Bytes fetched so far and the expected total, when the stage is
   * `downloading`.
   *
   * ⚠️ RESUME: `downloaded` counts bytes ON DISK, including a partial from a
   * previous attempt — not bytes fetched this attempt. Otherwise a resumed
   * download would show the bar jumping backwards to 0%, which reads as "it
   * restarted" to the one person the number exists for.
   */
  downloaded?: number;
  total?: number;
}

/** Map a journalled phase onto the stage a user should see. */
export function stageForPhase(phase: TxnPhase): UpgradeStage | null {
  switch (phase) {
    case "staged": return "staging";
    case "handing-over": return "handing-over";
    case "running-experiment":
    case "readback": return "probing";
    case "promoted": return "promoted";
    case "rolled-back": return "rolled-back";
    default: return null; // idle: nothing in flight, nothing to report
  }
}
