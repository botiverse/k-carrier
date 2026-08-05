/**
 * inproc fake-host (harness-design §1.1 first half) — an IN-PROCESS
 * HostAdapter implementation with per-method fault-injection switches and
 * a deterministic virtual-load ledger.
 *
 * Virtual load ledger: the fake host simulates a hosted "session" as a
 * deterministic state — a counter + rolling sha256 checksum — persisted
 * to `<stateDir>/ledger.bin`. quiesce() durably parks it (fsync), resume()
 * restores it; `quiesce↔resume` equivalence is the byte-for-byte ledger
 * comparison, including resume after rollback. This is the decidable form
 * of the managed profile's "session preservation" claim.
 *
 * Fault switches (per method, harness-design §1.1): fail-on-quiesce /
 * hang-on-stop / wrong-version-probe / stale-startId-probe /
 * crash-during-start. Teeth run the NORMAL contract with switches off
 * (green) and must go RED with a switch on — proving the tooth tests the
 * fault, not the norm.
 *
 * Time: the host touches time ONLY through the injected Clock (core's
 * clock seam); hang-on-stop is a clock-scheduled far-future resolution so
 * a scenario VirtualClock can detect it without real sleeps.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { type Clock, systemClock } from "../../../core/src/clock.ts";
import type { HostAdapter, ProcessEvidence, Slot } from "../../../core/src/lifecycle/hostAdapter.ts";

export interface FakeHostFaults {
  /** quiesce() throws. */
  failOnQuiesce?: boolean;
  /** stop() never completes (clock-scheduled far-future). */
  hangOnStop?: boolean;
  /** healthProbe() reports a version different from the running slot's. */
  wrongVersionProbe?: boolean;
  /** healthProbe() reports a PREVIOUS incarnation's startId (#5245 fake-green). */
  staleStartIdProbe?: boolean;
  /** start() throws. */
  crashDuringStart?: boolean;
}

export interface InprocFakeHostOptions {
  /** Where the virtual-load ledger lives (inside the scenario sandbox). */
  stateDir: string;
  /** Clock seam; default real system clock. Scenarios inject VirtualClock. */
  clock?: Clock;
  faults?: FakeHostFaults;
  /** Version of the binaries in each slot. */
  versions?: { stable: string; experiment: string };
}

export const LEDGER_FILE = "ledger.bin";
const LEDGER_PREFIX = "k-ledger-v1";
const COUNTER_BYTES = 8;
const CHECKSUM_BYTES = 32;
const HANG_HORIZON_MS = 1e12;

export interface LedgerState {
  counter: number;
  checksum: Uint8Array;
}

/**
 * The harness-side driving surface a fake host (or adopter adapter, in
 * --adapter mode) can expose beyond the plain HostAdapter contract: the
 * lifecycle getters the contract checks assert on, and the workload
 * driver the ledger-equivalence checks need. An adopter adapter that
 * cannot drive a deterministic workload simply omits doWork/ledger and
 * the ledger checks are marked na.
 */
export interface HostDriver extends HostAdapter {
  /** Slot currently running, or null. */
  readonly running: Slot | null;
  /** Whether the workload is currently parked (quiesced). */
  readonly parked: boolean;
  /** StartId of the current incarnation (evidence binding key). */
  readonly startId: string | null;
  /** Simulate n units of hosted session activity (deterministic). */
  doWork?(n: number): Promise<void>;
  /** Current ledger bytes (durability view). */
  ledger?(): Promise<Uint8Array>;
  /** Parsed ledger state. */
  ledgerState?(): Promise<LedgerState>;
}

export class InprocFakeHost implements HostDriver {
  private readonly stateDir: string;
  private readonly clock: Clock;
  private readonly faults: FakeHostFaults;
  private readonly versionBySlot: { stable: string; experiment: string };

  private counter = 0;
  private checksum: Uint8Array;
  private runningSlot: Slot | null = null;
  private quiesced = false;
  private incarnation = 0;
  private startIds: string[] = [];
  private parkedLedger: Uint8Array | null = null;

  constructor(opts: InprocFakeHostOptions) {
    this.stateDir = opts.stateDir;
    this.clock = opts.clock ?? systemClock;
    this.faults = opts.faults ?? {};
    this.versionBySlot = opts.versions ?? { stable: "1.0.0", experiment: "2.0.0" };
    this.checksum = createHash("sha256").update(LEDGER_PREFIX).digest();
  }

  /** Slot currently running, or null. */
  get running(): Slot | null {
    return this.runningSlot;
  }

  /** Whether the workload is currently parked (quiesced). */
  get parked(): boolean {
    return this.quiesced;
  }

  /** StartId of the current incarnation (evidence binding key). */
  get startId(): string | null {
    const current = this.startIds.at(-1);
    return current ?? null;
  }

  // -------------------------------------------------------------------------
  // HostAdapter contract
  // -------------------------------------------------------------------------

  async quiesce(): Promise<void> {
    if (this.faults.failOnQuiesce) throw new Error("fail-on-quiesce");
    if (this.quiesced) return; // idempotent
    if (!this.runningSlot) throw new Error("quiesce: no running slot");
    this.quiesced = true;
    // Durable park: flush the ledger (fsync) and keep the parked bytes.
    await this.writeLedger();
    this.parkedLedger = await this.readLedger();
  }

  async stop(slot: Slot): Promise<void> {
    if (this.faults.hangOnStop) {
      await new Promise<void>((resolve) => {
        this.clock.after(HANG_HORIZON_MS, resolve);
      });
      return;
    }
    if (this.runningSlot !== slot) throw new Error(`stop: ${slot} is not the running slot`);
    this.runningSlot = null;
  }

  async start(slot: Slot): Promise<void> {
    if (this.faults.crashDuringStart) throw new Error("crash-during-start");
    if (this.runningSlot !== null) throw new Error(`start: ${this.runningSlot} already running`);
    this.runningSlot = slot;
    this.incarnation += 1;
    this.startIds.push(`inc:${this.incarnation}:${this.clock.nowMs()}`);
  }

  async healthProbe(): Promise<ProcessEvidence> {
    const runningSlot = this.runningSlot;
    if (!runningSlot) throw new Error("probe: no running slot");
    const currentStartId = this.startIds.at(-1);
    if (!currentStartId) throw new Error("probe: no startId for running incarnation");
    const version = this.faults.wrongVersionProbe
      ? "9.9.9"
      : this.versionBySlot[runningSlot];
    let startId = currentStartId;
    if (this.faults.staleStartIdProbe) {
      const previous = this.startIds.at(-2);
      startId = previous ?? "stale-000";
    }
    return { version, pid: process.pid, startId };
  }

  async resume(): Promise<void> {
    if (!this.quiesced) throw new Error("resume: not quiesced");
    const parked = this.parkedLedger;
    if (!parked) throw new Error("resume: no parked ledger");
    const state = this.parseLedger(parked);
    this.counter = state.counter;
    this.checksum = state.checksum;
    this.quiesced = false;
    // Rewriting from the restored state must reproduce the parked bytes.
    await this.writeLedger();
  }

  // -------------------------------------------------------------------------
  // Harness-side workload driver
  // -------------------------------------------------------------------------

  /**
   * Simulate `n` units of hosted session activity: counter increments and
   * the checksum chains deterministically. Persisted to the ledger file.
   * Refuses while parked — a quiesced workload must not mutate the session.
   */
  async doWork(n: number): Promise<void> {
    if (this.quiesced) throw new Error("workload is parked (quiesced)");
    if (!this.runningSlot) throw new Error("doWork: no running slot");
    for (let i = 0; i < n; i++) {
      this.counter += 1;
      this.checksum = createHash("sha256").update(be64(this.counter)).update(this.checksum).digest();
    }
    await this.writeLedger();
  }

  /** Current ledger file bytes (what a durability check would read). */
  async ledger(): Promise<Uint8Array> {
    return this.readLedger();
  }

  /** Parsed ledger state (counter + checksum). */
  async ledgerState(): Promise<LedgerState> {
    return this.parseLedger(await this.readLedger());
  }

  // -------------------------------------------------------------------------
  // Ledger persistence
  // -------------------------------------------------------------------------

  private ledgerBytes(): Uint8Array {
    const out = new Uint8Array(COUNTER_BYTES + CHECKSUM_BYTES);
    new DataView(out.buffer).setBigUint64(0, BigInt(this.counter), false);
    out.set(this.checksum, COUNTER_BYTES);
    return out;
  }

  private parseLedger(bytes: Uint8Array): LedgerState {
    if (bytes.length !== COUNTER_BYTES + CHECKSUM_BYTES) {
      throw new Error(`ledger corrupted: ${bytes.length} bytes`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const counter = Number(view.getBigUint64(0, false));
    const checksum = bytes.slice(COUNTER_BYTES);
    return { counter, checksum };
  }

  private async writeLedger(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const fh = await fs.open(path.join(this.stateDir, LEDGER_FILE), "w");
    try {
      await fh.writeFile(this.ledgerBytes());
      await fh.sync(); // durable park at quiesce
    } finally {
      await fh.close();
    }
  }

  private async readLedger(): Promise<Uint8Array> {
    const raw = await fs.readFile(path.join(this.stateDir, LEDGER_FILE));
    return new Uint8Array(raw);
  }
}

function be64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}
