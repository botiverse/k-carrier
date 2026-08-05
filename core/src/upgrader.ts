import type { HostAdapter } from "./lifecycle/hostAdapter.js";
import type { TxnState } from "./txn/state.js";
import type { ConvergenceReport } from "./converge/predicates.js";

/**
 * Upgrader is the single facade an application calls. Every entrypoint the
 * app exposes (daemon-internal auto-update, `myapp upgrade` CLI command,
 * install script, remote drive) constructs the SAME Upgrader — one
 * canonical executor, so there is no entrypoint that "swaps bytes but
 * skips convergence" (the class of bug this framework exists to kill).
 */
export interface Upgrader {
  /** Resolve target version per channel/pin, verify availability. */
  check(): Promise<{ current: string; target: string | null }>;

  /**
   * Full transactional upgrade: stage -> handoff -> predicates -> promote,
   * rolling back automatically on any failure. Honors policy (auto /
   * confirm / notify-only) before side effects.
   */
  upgrade(): Promise<UpgradeOutcome>;

  /** Explicit rollback while an experiment is live (pre-promote). */
  rollback(reason: string): Promise<void>;

  /** Current transaction + slot state, readable at any time. */
  state(): Promise<TxnState>;
}

export type UpgradeOutcome =
  | { result: "promoted"; report: ConvergenceReport }
  | { result: "rolled-back"; reason: string; report: ConvergenceReport | null }
  | { result: "held"; reason: string } // policy or fail-closed hold; typed, never silent
  | { result: "up-to-date" };

/**
 * Everything an application provides to construct an Upgrader. No host
 * internals cross this boundary in either direction.
 */
export interface UpgraderConfig {
  host: HostAdapter;
  /** Static artifact base URL (manifest.json + files + signatures). */
  releaseBase: string;
  channel: "latest" | "alpha" | `pinned:${string}`;
  policy: "auto" | "confirm" | "notify-only";
  /** Where consent prompts / failure notifications are delivered. */
  notificationSink: (event: NotificationEvent) => Promise<void>;
  /** Root public keys for distsign verification (compiled into the app). */
  rootKeys: string[];
  stateDir: string;
}

export interface NotificationEvent {
  kind: "confirm-request" | "upgrade-failed" | "rolled-back" | "held" | "promoted";
  detail: Record<string, string>;
}
