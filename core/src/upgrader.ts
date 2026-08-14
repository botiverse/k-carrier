import type { HostAdapter } from "./lifecycle/hostAdapter.js";
import type { TxnState } from "./txn/state.js";
import type { ConvergenceReport } from "./converge/predicates.js";
import type { StatusReport } from "./status/report.js";
import type { ReleaseSource } from "./artifact/source.js";

/**
 * Who drove a reconcile, recorded in the provenance journal (M6, L5).
 * `who` is the driving identity (server/operator), `carrier` the channel
 * the command travelled on. The artifact VERSION is recorded by the
 * upgrader (it knows what it installed; the identity does not need to).
 * Local auto-updates use the upgrader's configured default identity.
 */
export interface ProvenanceIdentity {
  who: string;
  carrier: string;
}

/**
 * Upgrader is the single facade an application calls. Every entrypoint the
 * app exposes (daemon-internal auto-update, `myapp self upgrade`, install
 * script, remote drive) constructs the SAME Upgrader — one canonical
 * executor, so there is no entrypoint that "swaps bytes but skips
 * convergence" (the class of bug this framework exists to kill).
 */
export interface Upgrader {
  /**
   * Settle any transaction a previous coordinator left in flight.
   *
   * Recovery uses the same durable journal, host adapter, predicates and
   * upgrade lock as ordinary upgrades. It never consults the release source
   * or begins a new transaction; it only replays or rolls back work already
   * recorded by K. Hosts should run this from a coordinator that survives
   * service replacement, because recovery may stop and restart the service.
   */
  recover(): Promise<void>;

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
   *
   * `{ consented: true }` continues a policy=confirm flow AFTER the user
   * approved the offered version: the policy gate is skipped (the consent
   * WAS the gate), but the version is bound — if the source can no longer
   * serve the approved version, the continuation refuses instead of
   * silently installing whatever is current now. Consent is to a SPECIFIC
   * version, never to "the upgrade" as an event.
   */
  upgradeTo(version: string, opts?: { consented?: boolean; provenance?: ProvenanceIdentity }): Promise<UpgradeOutcome>;

  /**
   * Explicit rollback while an experiment is live (pre-promote).
   *
   * The ownership gate is drawn on the ACTION'S NATURE, not the method
   * name: settling an in-flight transaction K itself started (recover +
   * clear) is ALWAYS allowed — held must never land on a machine that is
   * halfway through a transaction (that is a brick). Only NEW modification
   * of a machine at rest that is managed elsewhere is refused, as a typed
   * `held` — never a rollback of another manager's copy.
   */
  rollback(reason: string): Promise<"rolled-back" | { held: string }>;

  /**
   * Fail-closed retirement: retire the legacy lifecycle manager (e.g. an
   * old OS auto-start entry) ONLY after host_lifecycle_converged passed on
   * the last promote. Before that, retires are refused with a typed HOLD —
   * removing the old supervisor without a converged replacement would
   * leave the machine with nothing to start the service.
   */
  retireLegacyManager(): Promise<"retired" | { held: string }>;

  /** Current transaction + slot state, readable at any time. */
  state(): Promise<TxnState>;

  /**
   * M6 fleet read-back (L5): what this machine reports about itself —
   * {phase, stable, experiment, predicates, policy, provenance}, read from
   * the LIVE sources at this moment. Predicates a machine never observed
   * are null (NOT_OBSERVED), never a fabricated pass.
   */
  status(): Promise<StatusReport>;
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
  /** Directory K owns for its journal, slots and staging area. */
  stateDir: string;
}

export interface NotificationEvent {
  kind:
    | "confirm-request"
    | "upgrade-failed"
    | "rolled-back"
    | "held"
    | "promoted";
  detail: Record<string, string>;
}
