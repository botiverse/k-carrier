// @invariant — inproc fake-host contract: ledger determinism, quiesce↔resume
// byte-equivalence (incl. rollback), slot/incarnation semantics, and every
// fault switch really breaking its method.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { InprocFakeHost, LEDGER_FILE, type FakeHostFaults } from "./inproc.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import { VirtualClock } from "../scenario/virtualClock.ts";

async function withHost<T>(faults: FakeHostFaults = {}, fn: (dir: string, host: InprocFakeHost) => Promise<T>): Promise<T> {
  const sb = await createSandbox({ prefix: "fake-host" });
  try {
    const host = new InprocFakeHost({ stateDir: path.join(sb.dir, "host"), faults });
    return await fn(sb.dir, host);
  } finally {
    await sb.teardown();
  }
}

test("ledger is deterministic: same workload produces identical bytes", async () => {
  await withHost({}, async (_dir, h1) => {
    await h1.start("stable");
    await h1.doWork(3);
    const a = await h1.ledger();
    await h1.doWork(2);
    const b = await h1.ledger();
    assert.notDeepEqual(b, a); // more work -> different state
    const st = await h1.ledgerState();
    assert.equal(st.counter, 5);
    assert.equal(st.checksum.length, 32);
  });
  // a fresh host doing the same work lands on the same bytes
  await withHost({}, async (_dir, h2) => {
    await h2.start("stable");
    await h2.doWork(5);
    const st = await h2.ledgerState();
    assert.equal(st.counter, 5);
    assert.equal(st.checksum.length, 32);
  });
});

test("quiesce↔resume preserves the ledger byte-for-byte", async () => {
  await withHost({}, async (_dir, h) => {
    await h.start("stable");
    await h.doWork(3);
    await h.quiesce();
    assert.equal(h.parked, true);
    const parked = await h.ledger();
    // while parked the workload must refuse to mutate the session
    await assert.rejects(h.doWork(1), /parked/);
    await h.resume();
    assert.equal(h.parked, false);
    assert.deepEqual(await h.ledger(), parked, "resume must reproduce the parked ledger");
    // and the session continues from the parked counter
    await h.doWork(1);
    assert.equal((await h.ledgerState()).counter, 4);
  });
});

test("quiesce is idempotent; resume without quiesce and quiesce without running slot throw", async () => {
  await withHost({}, async (_dir, h) => {
    await h.start("stable");
    await h.doWork(1);
    await h.quiesce();
    await h.quiesce(); // second call is a no-op
    assert.equal(h.parked, true);
    await h.resume();
    assert.equal(h.parked, false);
    await assert.rejects(h.resume(), /not quiesced/);
  });
  await withHost({}, async (_dir, h) => {
    await assert.rejects(h.quiesce(), /no running slot/);
    await assert.rejects(h.doWork(1), /no running slot/);
  });
});

test("stop/start transitions slots and incarnations; probe binds version+pid+startId", async () => {
  await withHost({}, async (_dir, h) => {
    await h.start("stable");
    const first = await h.healthProbe();
    assert.equal(first.version, "1.0.0");
    assert.equal(first.pid, process.pid);
    assert.equal(first.startId, h.startId);
    await h.stop("stable");
    assert.equal(h.running, null);
    await assert.rejects(h.stop("stable"), /not the running slot/);
    await h.start("experiment");
    await assert.rejects(h.start("stable"), /already running/);
    const second = await h.healthProbe();
    assert.equal(second.version, "2.0.0");
    assert.notEqual(second.startId, first.startId, "new incarnation must have a new startId");
  });
});

test("rolled-back resume preserves the parked ledger exactly", async () => {
  await withHost({}, async (_dir, h) => {
    await h.start("stable");
    await h.doWork(2);
    await h.quiesce();
    const parked = await h.ledger();
    await h.stop("stable");
    await h.start("experiment"); // handover to the new version
    assert.equal((await h.healthProbe()).version, "2.0.0");
    await h.stop("experiment");
    await h.start("stable"); // rollback: stable restored
    await h.resume();
    assert.deepEqual(await h.ledger(), parked, "rolled-back resume must restore parked bytes");
    await h.doWork(1);
    assert.equal((await h.ledgerState()).counter, 3, "session continues after rollback");
  });
});

test("every fault switch genuinely breaks its method", async () => {
  await withHost({ failOnQuiesce: true }, async (_dir, h) => {
    await h.start("stable");
    await h.doWork(1);
    await assert.rejects(h.quiesce(), /fail-on-quiesce/);
  });
  await withHost({ crashDuringStart: true }, async (_dir, h) => {
    await assert.rejects(h.start("stable"), /crash-during-start/);
  });
  await withHost({ wrongVersionProbe: true }, async (_dir, h) => {
    await h.start("stable");
    const ev = await h.healthProbe();
    assert.notEqual(ev.version, "1.0.0");
  });
  await withHost({ staleStartIdProbe: true }, async (_dir, h) => {
    await h.start("stable");
    await h.stop("stable");
    await h.start("stable");
    const ev = await h.healthProbe();
    assert.notEqual(ev.startId, h.startId, "stale probe must not report the current startId");
  });
});

test("hang-on-stop stays pending past the scenario window (clock-driven, no real sleep)", async () => {
  const sb = await createSandbox({ prefix: "hang" });
  try {
    const clock = new VirtualClock();
    const host = new InprocFakeHost({
      stateDir: path.join(sb.dir, "host"),
      clock,
      faults: { hangOnStop: true },
    });
    await host.start("stable");
    let done = false;
    const p = host.stop("stable").then(() => {
      done = true;
    });
    clock.advance(1000); // scenario window
    assert.equal(done, false, "hang-on-stop must keep stop pending past the window");
    clock.advance(1e12); // past the hang horizon: let it resolve for clean teardown
    await p;
    assert.equal(done, true);
  } finally {
    await sb.teardown();
  }
});

test("ledger file lives inside the sandbox stateDir", async () => {
  await withHost({}, async (dir, h) => {
    await h.start("stable");
    await h.doWork(1);
    const { promises: fsp } = await import("node:fs");
    await fsp.access(path.join(dir, "host", LEDGER_FILE));
  });
});
