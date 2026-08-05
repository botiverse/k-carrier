import type { HostAdapter } from "./lifecycle/hostAdapter.js";
import type { TxnState } from "./txn/state.js";
import type { ConvergenceReport } from "./converge/predicates.js";
import type { ReleaseSource } from "./artifact/source.js";

/**
 * Upgrader is the single facade an application calls. Every entrypoint the
 * app exposes (daemon-internal auto-update, `myapp self upgrade`, install
 * script, remote drive) constructs the SAME Upgrader — one canonical
 * executor, so there is no entrypoint that "swaps bytes but skips
 * convergence" (the class of bug this framework exists to kill).
 */
export interface Upgrader {
  /**
   * Ask the release source whether this install should move, without moving
   * it. `target: null` means nothing to do.
   */
  check(): Promise<{ current: string; target: string | null }>;

  /**
   * Policy-driven upgrade: ask the source what to upgrade to, then run the
   * full transaction (stage -> handoff -> predicates -> promote), rolling
   * back automatically on any failure. Honors policy before side effects.
   */
  upgrade(): Promise<UpgradeOutcome>;

  /**
   * Named upgrade: go to exactly this version now. Used by "let the user
   * pick a version" and by server-pushed "go to X". This is also the only
   * sanctioned DOWNGRADE path — downgrade is always explicit, never
   * automatic, and still subject to the same predicates and compatibility
   * checks.
   */
  upgradeTo(version: string): Promise<UpgradeOutcome>;

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
  /**
   * Where releases come from and what this install should be on. K holds no
   * versioning policy of its own: channels, "latest", version ordering and
   * long-term pinning all live inside your source. `staticManifestSource`
   * ships as one ready-made policy for the common case.
   */
  source: ReleaseSource;
  /** Decides whether an upgrade may proceed on this machine. */
  policy: "auto" | "confirm" | "notify-only";
  /** Where consent prompts / failure notifications are delivered. */
  notificationSink: (event: NotificationEvent) => Promise<void>;
  /** Root public keys for signature verification (compiled into the app). */
  rootKeys: string[];
  stateDir: string;
}

export interface NotificationEvent {
  kind:
    | "confirm-request"
    | "upgrade-failed"
    | "rolled-back"
    | "held"
    | "promoted"
    /** Installing bytes the client chose to accept without attribution. */
    | "installed-unverified";
  detail: Record<string, string>;
}
