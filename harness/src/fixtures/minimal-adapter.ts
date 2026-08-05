/**
 * Minimal adopter adapter fixture — an INDEPENDENT HostAdapter + workload
 * driver used to exercise `k-harness --adapter` (harness-design §1.7: the
 * adopter contract subset runs against the adapter, not the fake host).
 *
 * It is intentionally NOT InprocFakeHost: a real adopter brings its own
 * host semantics; this one is a from-scratch minimal implementation of the
 * same contract surface (its own ledger bytes, its own startIds), so the
 * adapter-mode tests prove the contract checks are host-agnostic.
 *
 * Default export contract: `(stateDir: string) => HostDriver`.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ProcessEvidence, Slot } from "../../../core/src/lifecycle/hostAdapter.ts";
import type { HostDriver, LedgerState } from "../fake-host/inproc.ts";

const LEDGER = "adapter-ledger.bin";

export function createMinimalAdapter(stateDir: string): HostDriver {
  let counter = 0;
  let checksum: Uint8Array = createHash("sha256").update("minimal-adapter-v1").digest();
  let runningSlot: Slot | null = null;
  let parked = false;
  let incarnation = 0;
  let currentStartId: string | null = null;

  const ledgerBytes = (): Uint8Array => {
    const out = new Uint8Array(8 + 32);
    new DataView(out.buffer).setBigUint64(0, BigInt(counter), false);
    out.set(checksum, 8);
    return out;
  };

  const writeLedger = async (): Promise<void> => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, LEDGER), ledgerBytes());
  };

  return {
    async quiesce() {
      if (parked) return;
      if (!runningSlot) throw new Error("quiesce: no running slot");
      parked = true;
      await writeLedger();
    },
    async stop(slot: Slot) {
      if (runningSlot !== slot) throw new Error(`stop: ${slot} is not the running slot`);
      runningSlot = null;
    },
    async start(slot: Slot) {
      if (runningSlot !== null) throw new Error(`start: ${runningSlot} already running`);
      runningSlot = slot;
      incarnation += 1;
      currentStartId = `minimal-inc:${incarnation}`;
    },
    async healthProbe(): Promise<ProcessEvidence> {
      if (!runningSlot) throw new Error("probe: no running slot");
      if (!currentStartId) throw new Error("probe: no startId");
      return {
        version: runningSlot === "stable" ? "1.0.0" : "2.0.0",
        pid: process.pid,
        startId: currentStartId,
      };
    },
    async resume() {
      if (!parked) throw new Error("resume: not quiesced");
      parked = false;
      // restore in-memory state from the parked ledger file
      const raw = new Uint8Array(await fs.readFile(path.join(stateDir, LEDGER)));
      counter = Number(new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false));
      checksum = raw.slice(8);
    },
    get running(): Slot | null {
      return runningSlot;
    },
    get parked(): boolean {
      return parked;
    },
    get startId(): string | null {
      return currentStartId;
    },
    async doWork(n: number) {
      if (parked) throw new Error("workload is parked (quiesced)");
      if (!runningSlot) throw new Error("doWork: no running slot");
      for (let i = 0; i < n; i++) {
        counter += 1;
        checksum = createHash("sha256").update(be64(counter)).update(checksum).digest();
      }
      await writeLedger();
    },
    async ledger(): Promise<Uint8Array> {
      return new Uint8Array(await fs.readFile(path.join(stateDir, LEDGER)));
    },
    async ledgerState(): Promise<LedgerState> {
      return { counter, checksum };
    },
  };
}

function be64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

export default createMinimalAdapter;
