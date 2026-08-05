/**
 * HostAdapter is the entire surface a host service must implement to be
 * upgraded by carrier. The core calls ONLY this interface — it never knows
 * host internals. This is the mechanical guarantee behind "any daemon can
 * use this", and the harness's fake host implements exactly this.
 *
 * Contract highlights:
 *  - quiesce(): workloads (sessions, agents, jobs) must be safely pausable
 *    and durably parked; state before quiesce() and after resume() must be
 *    equivalent — including when resume() happens on the ROLLED-BACK slot.
 *  - healthProbe(): evidence must be bound to one live process (same-PID /
 *    startId), never assembled from files or caches. A probe that cannot
 *    prove which process answered is not a probe.
 */
export interface HostAdapter {
  /** Park all hosted workloads durably. Idempotent. */
  quiesce(): Promise<void>;

  /** Stop the resident service process tree for the given slot. */
  stop(slot: Slot): Promise<void>;

  /** Start the resident service from the given slot's binaries. */
  start(slot: Slot): Promise<void>;

  /**
   * Probe the LIVE process. Returned evidence must all come from the same
   * process instance (pid + startId bind the answer to one incarnation).
   */
  healthProbe(): Promise<ProcessEvidence>;

  /** Resume workloads parked by quiesce(). Must also work after rollback. */
  resume(): Promise<void>;
}

export type Slot = "stable" | "experiment";

export interface ProcessEvidence {
  /** Version string reported by the live process itself. */
  version: string;
  pid: number;
  /**
   * Monotonic per-incarnation identity (e.g. start timestamp + random),
   * so evidence cannot be satisfied by a pid reused by another process.
   */
  startId: string;
}
