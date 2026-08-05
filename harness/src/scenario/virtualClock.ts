/**
 * VirtualClock — deterministic Clock for scenarios (harness-design §1.3).
 * Time moves only via advance(); timers fire in due-time order (FIFO among
 * equals), and timers scheduled by fired callbacks within the advanced
 * window fire in the same advance() call. No real sleeping anywhere.
 */
import type { Clock } from "../../../core/src/clock.ts";

interface PendingTimer {
  dueMs: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

export class VirtualClock implements Clock {
  private currentMs = 0;
  private seq = 0;
  private timers: PendingTimer[] = [];

  nowMs(): number {
    return this.currentMs;
  }

  after(ms: number, fn: () => void): () => void {
    const t: PendingTimer = {
      dueMs: this.currentMs + Math.max(0, ms),
      seq: this.seq++,
      fn,
      cancelled: false,
    };
    this.timers.push(t);
    return () => {
      t.cancelled = true;
    };
  }

  /** Advance virtual time, firing due timers in (dueMs, seq) order. */
  advance(ms: number): void {
    const target = this.currentMs + Math.max(0, ms);
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.dueMs <= target)
        .sort((a, b) => a.dueMs - b.dueMs || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.currentMs = due.dueMs;
      due.fn(); // may schedule more timers within the window
    }
    this.currentMs = target;
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}
