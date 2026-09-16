// @invariant — process-reality guarantees: real spawn, real SIGKILL, real
// liveness. These cannot be satisfied by an in-process mock, which is the point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DaemonFakeHost, processAlive } from "./daemon.ts";

/**
 * Every host is torn down even when the test fails: a surviving child holds
 * its stdio pipes and turns a clean assertion failure into a hang. Hangs are
 * bugs (harness-design: determinism first), so teardown is unconditional.
 */
function host(t: { after: (fn: () => void | Promise<void>) => void }): DaemonFakeHost {
  const h = new DaemonFakeHost({ slotVersions: { stable: "1.0.0", experiment: "2.0.0" } });
  t.after(async () => {
    await h.teardownVerifyDead();
  });
  return h;
}

test("start spawns a REAL process the OS confirms alive; stop proves it dead", async (t) => {
  const h = host(t);
  await h.start("stable");
  const evidence = await h.healthProbe();
  assert.equal(evidence.version, "1.0.0");
  assert.ok(processAlive(evidence.pid), "OS must report the spawned pid alive");
  await h.stop("stable");
  assert.equal(processAlive(evidence.pid), false, "stop must leave the pid actually gone");
});

test("startId distinguishes incarnations even though both are real processes", async (t) => {
  const h = host(t);
  await h.start("stable");
  const first = await h.healthProbe();
  await h.stop("stable");
  await h.start("stable");
  const second = await h.healthProbe();
  await h.teardownVerifyDead();
  assert.notEqual(first.startId, second.startId, "each incarnation needs a distinct startId");
});

test("probe evidence comes from the live process (version follows the started slot)", async (t) => {
  const h = host(t);
  await h.start("experiment");
  const evidence = await h.healthProbe();
  assert.equal(evidence.version, "2.0.0", "evidence must reflect the slot actually started");
  await h.teardownVerifyDead();
});

test("crash() is a real SIGKILL: no orderly shutdown, pid gone", async (t) => {
  const h = host(t);
  await h.start("stable");
  const pid = await h.crash();
  assert.ok(pid !== null);
  assert.equal(processAlive(pid), false);
});

test("teardownVerifyDead proves every started pid is gone (zero survivors)", async (t) => {
  const h = host(t);
  await h.start("stable");
  await h.stop("stable");
  await h.start("experiment");
  const result = await h.teardownVerifyDead();
  assert.deepEqual(result.survivors, [], "teardown must leave no survivors");
  assert.equal(h.livePids().length, 0, "no started pid may remain alive");
  for (const pid of result.killed) assert.equal(processAlive(pid), false);
});

test("livePids never reports two incarnations at once during a handover", async (t) => {
  const h = host(t);
  await h.start("stable");
  assert.equal(h.livePids().length, 1);
  await h.stop("stable"); // handover: old must die before new starts
  await h.start("experiment");
  assert.equal(h.livePids().length, 1, "dual-run: two incarnations alive simultaneously");
  await h.teardownVerifyDead();
});
