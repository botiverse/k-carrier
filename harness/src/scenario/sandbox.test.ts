// @invariant — scenario sandbox isolation: one scenario one sandbox; live
// sandboxes never share dir or port; teardown removes everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { createSandbox, allocatePort } from "./sandbox.ts";

test("two live sandboxes get distinct dirs and distinct ports", async () => {
  const a = await createSandbox({ prefix: "a" });
  const b = await createSandbox({ prefix: "b" });
  try {
    assert.notEqual(a.dir, b.dir);
    assert.notEqual(a.port, b.port);
  } finally {
    await a.teardown();
    await b.teardown();
  }
});

test("sandbox dir carries the marker file (future pgrep-by-marker key)", async () => {
  const sb = await createSandbox({ prefix: "marker" });
  try {
    const marker = await fs.readFile(path.join(sb.dir, ".k-sandbox-marker"), "utf8");
    assert.equal(marker.trim(), sb.id);
    assert.ok(sb.id.startsWith("k-harness-marker-"));
  } finally {
    await sb.teardown();
  }
});

test("teardown removes the tree and is idempotent", async () => {
  const sb = await createSandbox({ prefix: "gone" });
  const dir = sb.dir;
  await fs.writeFile(path.join(dir, "leftover.txt"), "x"); // scenario residue
  await sb.teardown();
  await assert.rejects(fs.access(dir));
  await sb.teardown(); // second call is a no-op, not an error
});

test("allocatePort hands out distinct ports while reservations are live", async () => {
  const p1 = await allocatePort();
  const p2 = await allocatePort();
  const p3 = await allocatePort();
  assert.notEqual(p1, p2);
  assert.notEqual(p2, p3);
  assert.notEqual(p1, p3);
});

test("allocatePort returns a bindable port", async () => {
  const port = await allocatePort();
  const { createServer } = await import("node:net");
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve());
  });
  s.close();
});

// ---------------------------------------------------------------------------
// process-tree verify-dead (harness-design §1.77: "发了 kill" ≠ "死了")
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { findPidsByEnv, MARKER_ENV, verifyProcessTreeDead } from "./sandbox.ts";
import { DaemonFakeHost, processAlive } from "../fake-host/daemon.ts";

function spawnMarkerChild(markerId: string): { child: ReturnType<typeof spawn>; pid: number } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, [MARKER_ENV]: markerId },
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("child did not get a pid");
  return { child, pid: child.pid };
}

async function waitVisible(markerId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (findPidsByEnv(MARKER_ENV, markerId).length === 0) {
    if (Date.now() > deadline) throw new Error(`marker ${markerId} never visible`);
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
}

test("findPidsByEnv finds marker processes and ignores unmarked ones", async () => {
  const sb = await createSandbox({ prefix: "scan" });
  const { child, pid } = spawnMarkerChild(sb.id);
  try {
    await waitVisible(sb.id);
    const found = findPidsByEnv(MARKER_ENV, sb.id);
    assert.ok(found.includes(pid), `marker child ${pid} must be found (got ${found})`);
    assert.ok(found.length > 0);
    assert.deepEqual(findPidsByEnv(MARKER_ENV, "no-such-marker-xyz"), []);
  } finally {
    child.kill("SIGKILL");
    await sb.teardown();
  }
});

test("sandbox teardown SIGKILLs marker processes and proves them dead", async () => {
  const sb = await createSandbox({ prefix: "kill" });
  const { child, pid } = spawnMarkerChild(sb.id);
  try {
    await waitVisible(sb.id);
    assert.ok(processAlive(pid));
    await sb.teardown();
    assert.equal(processAlive(pid), false, "teardown must leave the marker process OS-dead");
    assert.deepEqual(findPidsByEnv(MARKER_ENV, sb.id), [], "zero marker residuals");
  } finally {
    if (processAlive(pid)) child.kill("SIGKILL");
    await sb.teardown().catch(() => {});
  }
});

test("teardown with no marker processes is a clean no-op", async () => {
  const sb = await createSandbox({ prefix: "clean" });
  await sb.teardown();
  await assert.rejects(import("node:fs").then((m) => m.promises.access(sb.dir)));
});

test("verifyProcessTreeDead kills marked processes and confirms death (green path)", async () => {
  const sb = await createSandbox({ prefix: "verify" });
  const { child, pid } = spawnMarkerChild(sb.id);
  try {
    await waitVisible(sb.id);
    assert.ok(processAlive(pid));
    await verifyProcessTreeDead(sb.dir, sb.id); // must not throw
    assert.equal(processAlive(pid), false, "verify must leave the process OS-dead");
  } finally {
    if (processAlive(pid)) child.kill("SIGKILL");
    await sb.teardown().catch(() => {});
  }
});

// Note on the VerifyDeadError survivor path: SIGKILL is universally fatal,
// so a survivor only occurs for processes that cannot be killed (e.g. an
// unreaped zombie whose env is no longer visible to the marker scan, or a
// D-state process). Constructing one reliably from userspace is not
// possible; the typed error is the defensive contract for exactly that
// case (the daemon's teardownVerifyDead carries the same shape). The
// tooth's known-red (skipTeardownKill) pins the assertion level instead.

test("DaemonFakeHost incarnations carry the sandbox marker; teardown proves them dead", async (t) => {
  const sb = await createSandbox({ prefix: "daemon-marker" });
  t.after(async () => {
    await sb.teardown().catch(() => {});
  });
  const host = new DaemonFakeHost({
    slotVersions: { stable: "1.0.0", experiment: null },
    env: sb.envMarker(),
  });
  t.after(async () => {
    await host.teardownVerifyDead();
  });
  await host.start("stable");
  await waitVisible(sb.id);
  const evidence = await host.healthProbe();
  assert.ok(findPidsByEnv(MARKER_ENV, sb.id).includes(evidence.pid));
  await host.teardownVerifyDead();
  assert.deepEqual(findPidsByEnv(MARKER_ENV, sb.id), [], "daemon teardown must clear the marker");
});
