/**
 * HostAdapter is the entire surface a host service must implement to be
 * upgraded by K. The core calls ONLY this interface — it never knows
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
 *  - start(): may return BEFORE the process exists. Some hosts cannot start
 *    themselves at all -- a service that is replaced by exiting, letting its
 *    supervisor respawn it from the new bytes, is started by that supervisor,
 *    asynchronously. So start() means "the successor has been asked for",
 *    never "the successor is running": only healthProbe() can say that.
 *
 * A consequence worth stating, because it decides who finishes an upgrade:
 * on such hosts the process driving the transaction DIES on the success path.
 * The successor finds a journal that stops mid-handover -- indistinguishable
 * from a crash -- and K resolves it by EVIDENCE (a live process reporting the
 * experiment version from a different incarnation), never by a flag saying the
 * restart was planned. A crash could set that flag just as easily.
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

/**
 * A SLOT is a place on disk that holds one version's bytes — not a channel,
 * not a release track, not a feature flag.
 *
 * K keeps exactly two so that installing never destroys the thing that
 * currently works:
 *
 *   stable      the version you are running and can always fall back to
 *   experiment  the version being tried right now; discarded if it fails
 *
 * "Promote" means the experiment's bytes become the stable ones; "roll back"
 * means the experiment is thrown away and stable was never touched. That is
 * the whole reason the transaction can be safe: the fallback is not
 * reconstructed after a failure, it was never disturbed.
 *
 * ⚠️ `stable` here is a POSITION, not the name of a release channel. If your
 * product also has a channel called "stable" (ours does), they are unrelated:
 * a channel says which stream you follow, a slot says which copy on disk.
 */
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
