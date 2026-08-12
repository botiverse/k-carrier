/**
 * Clock seam — core's ONLY access to time.
 *
 * Production-grade injection surface (transparency principle §1.8): core
 * never calls Date.now()/setTimeout directly; everything time-related goes
 * through an injected Clock. The default is the real system clock, so this
 * is dependency injection, not a test mode. A future CI ratchet forbids
 * direct time APIs inside core/ (same technique as Raft's clock-ratchet).
 */
export interface Clock {
  nowMs(): number;
  /** Schedule fn after ms; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
