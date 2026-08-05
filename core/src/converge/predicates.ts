/**
 * Convergence predicates: an upgrade must mechanically PROVE it happened.
 * Lifted from Raft spec #395; the part no existing updater has.
 *
 * Rules (each enforced by a harness tooth):
 *  - Evidence for binary_at_target comes from ONE live process
 *    (ProcessEvidence.pid + startId), never from files/caches.
 *  - Evidence for host_lifecycle_converged comes from a NAMED SSOT surface
 *    declared by the platform adapter (e.g. macOS login-item via Electron
 *    `app.getLoginItemSettings().openAtLogin`). A surface that cannot be
 *    read back on a real machine may not claim same-source.
 *  - PROJECTION BAN: version strings, release metadata, upgrade counts and
 *    any metadata field must NOT satisfy either predicate. The teeth
 *    feed true metadata + false surfaces and require non-green.
 *  - FAIL-CLOSED RETIREMENT: legacy lifecycle managers (e.g. an old OS
 *    supervisor entry) may be retired only AFTER host_lifecycle_converged
 *    passed; otherwise keep the legacy manager and surface a typed HOLD.
 */
export interface PredicateResult {
  passed: boolean;
  /** Named surface the evidence was read from (auditable, not prose). */
  source: string;
  observedAtMs: number;
  detail: Record<string, string>;
}

export interface ConvergenceReport {
  binaryAtTarget: PredicateResult;
  /**
   * null = the app declared no OS-lifecycle read-back surface, so this was
   * never observed. NOT the same as passing.
   *
   * It used to be reported as `{passed: true, source:
   * "no-lifecycle-surfaces-configured"}`, which reads like a checked property
   * and unlocked `retireLegacyManager()` -- retiring the machine's supervisor
   * on the strength of something nobody looked at. Silence must never be
   * spendable as evidence, so the absence has its own value in the type and
   * every consumer has to handle it.
   */
  hostLifecycleConverged: PredicateResult | null;
}

/**
 * Platform adapters declare their readback surfaces up front; converge
 * refuses surfaces not on this allowlist (the named-surface discipline).
 */
export interface ReadbackSurface {
  id: string; // e.g. "electron.getLoginItemSettings.openAtLogin"
  read(): Promise<{ value: string; source: string }>;
}
