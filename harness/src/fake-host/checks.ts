/**
 * fake-host acceptance checks — run bodies of the fake-host teeth
 * (registered in teeth/fakeHost.ts), and the contract subset the
 * `k-harness --adapter` mode reuses. Each throws on violation.
 *
 * Every check runs the NORMAL HostAdapter contract with faults OFF; a fault
 * switch turned ON must turn the check red (the tooth "catches" the fault),
 * and with the switch OFF the tooth is green — proving the tooth tests the
 * fault, not the norm (harness-design §1.1).
 *
 * The ledger equivalence (incl. after rollback) is the decidable form of
 * the managed profile's "session preservation": quiesce parks a
 * deterministic counter+checksum ledger durably, resume must reproduce it
 * byte-for-byte.
 *
 * Checks accept an injected host (adapter mode): the ledger checks need
 * the workload driver (doWork/ledger/ledgerState); an adapter without one
 * gets those checks marked na by the runner.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { type ToothContext } from "../teeth/registry.ts";
import { InprocFakeHost, type FakeHostFaults, type HostDriver, type InprocFakeHostOptions } from "./inproc.ts";
import { VirtualClock } from "../scenario/virtualClock.ts";

export interface ContractCheckOptions {
  /** Fault switches for the default InprocFakeHost. Ignored when host is injected. */
  faults?: FakeHostFaults;
  /** Inject a host (adapter mode); default: fresh InprocFakeHost. */
  host?: HostDriver;
}

function hostFor(ctx: ToothContext, opts: ContractCheckOptions): HostDriver {
  if (opts.host) return opts.host;
  const init: InprocFakeHostOptions = { stateDir: path.join(ctx.sandboxDir, "host") };
  if (opts.faults !== undefined) init.faults = opts.faults;
  return new InprocFakeHost(init);
}

/** Whether the host exposes the workload driver the ledger checks need. */
export function hasWorkloadDriver(host: HostDriver): boolean {
  return (
    typeof host.doWork === "function" &&
    typeof host.ledger === "function" &&
    typeof host.ledgerState === "function"
  );
}

export async function checkLedgerEquivalence(
  ctx: ToothContext,
  opts: ContractCheckOptions = {},
): Promise<void> {
  const host = hostFor(ctx, opts);
  if (!hasWorkloadDriver(host)) throw new Error("ledger-equivalence requires a workload driver");
  await host.start("stable");
  await host.doWork!(3);
  await host.quiesce();
  const parked = await host.ledger!();
  // A parked workload must not mutate the session.
  await assert.rejects(host.doWork!(1), /parked/, "quiesced workload must not mutate the session");
  await host.resume();
  assert.deepEqual(
    await host.ledger!(),
    parked,
    "ledger must be byte-identical across quiesce↔resume",
  );
  // Session continues from the parked counter.
  await host.doWork!(1);
  assert.equal(
    (await host.ledgerState!()).counter,
    4,
    "resumed session must continue from the parked counter",
  );
}

export async function checkLedgerEquivalenceAfterRollback(
  ctx: ToothContext,
  opts: ContractCheckOptions = {},
): Promise<void> {
  const host = hostFor(ctx, opts);
  if (!hasWorkloadDriver(host)) {
    throw new Error("ledger-equivalence-after-rollback requires a workload driver");
  }
  await host.start("stable");
  await host.doWork!(2);
  await host.quiesce();
  const parked = await host.ledger!();
  // Handover to the experiment slot, then roll back to stable.
  await host.stop("stable");
  await host.start("experiment");
  const probe = await host.healthProbe();
  assert.equal(probe.version, "2.0.0", "experiment slot must report its own version");
  await host.stop("experiment");
  await host.start("stable");
  await host.resume();
  assert.deepEqual(
    await host.ledger!(),
    parked,
    "rolled-back resume must restore the parked ledger byte-for-byte",
  );
  await host.doWork!(1);
  assert.equal(
    (await host.ledgerState!()).counter,
    3,
    "session must continue after rolled-back resume",
  );
}

export async function checkQuiesceCompletes(
  ctx: ToothContext,
  opts: ContractCheckOptions = {},
): Promise<void> {
  const host = hostFor(ctx, opts);
  await host.start("stable");
  await host.doWork?.(1);
  await host.quiesce(); // fail-on-quiesce throws here -> red
  assert.equal(host.parked, true);
}

export async function checkStopCompletes(
  ctx: ToothContext,
  opts: ContractCheckOptions = {},
): Promise<void> {
  const injected = opts.host;
  if (injected) {
    // Adapter mode has no clock-window semantics: stop must simply settle.
    await injected.start("stable");
    await injected.stop("stable");
    return;
  }
  const clock = new VirtualClock();
  const init: InprocFakeHostOptions = {
    stateDir: path.join(ctx.sandboxDir, "host"),
    clock,
  };
  if (opts.faults !== undefined) init.faults = opts.faults;
  const host = new InprocFakeHost(init);
  await host.start("stable");
  let done = false;
  const p = host.stop("stable").then(() => {
    done = true;
  });
  await Promise.resolve(); // let an immediate stop settle
  clock.advance(1000); // the scenario window; a hanging stop stays pending
  if (done) await p; // surface rejection only when it resolved
  assert.equal(done, true, "stop must complete within the window");
}

export async function checkProbeVersionMatchesSlot(
  ctx: ToothContext,
  opts: ContractCheckOptions = {},
): Promise<void> {
  const host = hostFor(ctx, opts);
  await host.start("stable");
  const stableProbe = await host.healthProbe();
  assert.equal(stableProbe.version, "1.0.0", "probe must report the stable slot's version");
  await host.stop("stable");
  await host.start("experiment");
  const expProbe = await host.healthProbe();
  assert.equal(expProbe.version, "2.0.0", "probe must report the experiment slot's version");
}

export async function checkProbeBindsCurrentIncarnation(
  ctx: ToothContext,
  opts: ContractCheckOptions = {},
): Promise<void> {
  const host = hostFor(ctx, opts);
  await host.start("stable");
  const first = await host.healthProbe();
  await host.stop("stable");
  await host.start("stable"); // new incarnation
  const second = await host.healthProbe();
  assert.notEqual(
    second.startId,
    first.startId,
    "a new incarnation must have a fresh startId (#5245 anti-fake-green)",
  );
  assert.equal(second.startId, host.startId, "probe must report the CURRENT startId");
}

export async function checkStartCompletes(
  ctx: ToothContext,
  opts: ContractCheckOptions = {},
): Promise<void> {
  const host = hostFor(ctx, opts);
  await host.start("stable"); // crash-during-start throws here -> red
  assert.equal(host.running, "stable");
}
