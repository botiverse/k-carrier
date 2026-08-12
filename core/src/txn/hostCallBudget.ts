/**
 * A bound on how long one host call may take.
 *
 * A host that HANGS is worse than one that crashes: nothing is journaled, the
 * upgrade lock stays held by a process that is still ALIVE (so stale-lock
 * takeover never fires), and every later attempt queues behind it forever.
 * That is the "wedged half-way" failure, and it is the one an updater is least
 * able to explain afterwards.
 */

/**
 * Default budget for a single host call. Long enough for a real service to
 * drain sessions on a busy machine, short enough that a wedge is reported the
 * same day it happens. Adopters override it via EngineDeps.hostCallBudgetMs.
 */
export const DEFAULT_HOST_CALL_BUDGET_MS = 120_000;

/** A host call exceeded its budget: the host is wedged, not merely failing. */
export class HostCallTimeout extends Error {
  readonly call: string;
  readonly budgetMs: number;
  constructor(call: string, budgetMs: number) {
    super(`host ${call}() did not return within ${budgetMs}ms — treating the host as wedged`);
    this.name = "HostCallTimeout";
    this.call = call;
    this.budgetMs = budgetMs;
  }
}
