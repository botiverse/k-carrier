/**
 * hosted-service — the managed-profile example (design-v1 §2.5: full stack,
 * the Raft-Computer-shaped host).
 *
 * A HostDriver implementation a real managed host would ship: five-method
 * HostAdapter plus a deterministic session ledger (a counter + rolling
 * sha256 chain persisted to `<stateDir>/session.bin`). quiesce() parks the
 * sessions durably, resume() restores them byte-for-byte — including after
 * a rollback to the stable slot. This is the decidable form of the
 * managed profile's "session preservation" claim.
 *
 * This is the demo's OWN host (a real adopter brings its own), not the
 * harness's fake — accepted by `k-harness --adapter examples/hosted-service/host.ts`
 * (contract subset: ledger equivalence ×2 + probe veracity/binding) and by
 * the registered tooth `examples.hosted-service-adapter` in the managed tier.
 *
 * Default export contract: `(stateDir: string) => HostDriver`.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ProcessEvidence, Slot } from "../../core/src/lifecycle/hostAdapter.ts";
import type { HostDriver, LedgerState } from "../../harness/src/fake-host/inproc.ts";

const SESSION_FILE = "session.bin";

export function createManagedHost(stateDir: string): HostDriver {
  let counter = 0;
  let checksum: Uint8Array = createHash("sha256").update("hosted-service-v1").digest();
  let runningSlot: Slot | null = null;
  let parked = false;
  let incarnation = 0;
  let currentStartId: string | null = null;

  const sessionBytes = (): Uint8Array => {
    const out = new Uint8Array(8 + 32);
    new DataView(out.buffer).setBigUint64(0, BigInt(counter), false);
    out.set(checksum, 8);
    return out;
  };

  const writeSession = async (): Promise<void> => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, SESSION_FILE), sessionBytes());
  };

  return {
    async quiesce() {
      if (parked) return; // idempotent
      if (!runningSlot) throw new Error("quiesce: no running slot");
      parked = true;
      await writeSession(); // durable park
    },
    async stop(slot: Slot) {
      if (runningSlot !== slot) throw new Error(`stop: ${slot} is not the running slot`);
      runningSlot = null;
    },
    async start(slot: Slot) {
      if (runningSlot !== null) throw new Error(`start: ${runningSlot} already running`);
      runningSlot = slot;
      incarnation += 1;
      currentStartId = `managed-inc:${incarnation}`;
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
      // restore the session state from the parked file, byte-for-byte
      const raw = new Uint8Array(await fs.readFile(path.join(stateDir, SESSION_FILE)));
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
      if (parked) throw new Error("sessions are parked (quiesced)");
      if (!runningSlot) throw new Error("doWork: no running slot");
      for (let i = 0; i < n; i++) {
        counter += 1;
        checksum = createHash("sha256").update(be64(counter)).update(checksum).digest();
      }
      await writeSession();
    },
    async ledger(): Promise<Uint8Array> {
      return new Uint8Array(await fs.readFile(path.join(stateDir, SESSION_FILE)));
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

export default createManagedHost;
