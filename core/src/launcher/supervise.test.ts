/** @invariant A real install settles its original operation, or retains verified offline recovery. */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { bootstrapStable } from "../bootstrap.ts";
import { createCommandHost } from "../lifecycle/commandHost.ts";
import { superviseRunner, resumeRunner } from "./supervise.ts";
import { platformOpsFor } from "../platform/index.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const request = (id: string, targetVersion = "2.0.0") => ({ protocolVersion: 1 as const,
  action: "upgrade" as const, id, targetVersion, consented: true });
const releaseOf = (bytes: Buffer) => ({ version: "runner", url: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
  size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(20); }
  assert.fail("process boundary was never reached");
}

test("supervisor: worker crash, bounded hangs, commit replay, offline retry and newer operation isolation", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k-supervisor-"));
  const previous = process.env.K_EXAMPLE_HOME;
  process.env.K_EXAMPLE_HOME = dir;
  const stateDir = path.join(dir, "k");
  const host = createCommandHost({ stateDir, command: [process.execPath, path.join(dir, "controller.mjs"), dir] });
  t.after(async () => {
    await host.stop("stable").catch(() => {});
    if (previous === undefined) delete process.env.K_EXAMPLE_HOME; else process.env.K_EXAMPLE_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.copyFile(path.join(root, "examples/external-service/controller.mjs"), path.join(dir, "controller.mjs"));
  const template = await fs.readFile(path.join(root, "examples/external-service/service.mjs"), "utf8");
  const initial = path.join(dir, "initial.mjs");
  await fs.writeFile(initial, template.replace("VERSION_PLACEHOLDER", "1.0.0"));
  await bootstrapStable({ stateDir, version: "1.0.0", artifactPath: initial });
  await host.start("stable");
  const helper = path.join(dir, "helper.mjs");
  await exec(process.execPath, [path.join(root, "scripts/build-runner.mjs"),
    path.join(root, "harness/src/fixtures/supervisedAdapter.ts"), helper], { cwd: root });
  const release = releaseOf(await fs.readFile(helper));
  const common = { release, interpreter: process.execPath, scratchDir: path.join(dir, "scratch"),
    executionTimeoutMs: 1500, recoveryTimeoutMs: 1500, totalTimeoutMs: 6000 };
  async function publish(version: string) {
    const artifact = releaseOf(Buffer.from(template.replace("VERSION_PLACEHOLDER", version)));
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify({ ...artifact, version }));
  }
  await publish("2.0.0");
  for (const mode of ["stop-crash", "stop-hang"]) {
    await fs.writeFile(path.join(dir, "fault"), mode);
    const result = await superviseRunner({ ...common, request: request(mode) });
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.equal(result.recoveryFile, null);
    assert.equal(result.attempts, 2);
    assert.equal(result.response?.operation.kind, "observed");
    assert.equal((await host.healthProbe()).version, "1.0.0");
  }
  // Both the initial worker and recovery workers hang; retries/deadline must end.
  await fs.rm(path.join(dir, "stopped"), { force: true });
  await fs.writeFile(path.join(dir, "fault"), "recovery-hang");
  const started = Date.now();
  const unresolved = await superviseRunner({ ...common, request: request("unresolved"), recoveryTimeoutMs: 200, recoveryAttempts: 2 });
  assert.equal(unresolved.exitCode, 3);
  assert.equal(unresolved.attempts, 3);
  assert.ok(Date.now() - started < 6000);
  assert.ok(unresolved.recoveryFile);
  const descriptor = JSON.parse(await fs.readFile(unresolved.recoveryFile, "utf8")) as { file: string };
  const retained = await fs.readFile(descriptor.file);
  assert.ok(retained.length > 0);
  await fs.appendFile(descriptor.file, "corrupted");
  await assert.rejects(resumeRunner(unresolved.recoveryFile), /RECOVERY_ARTIFACT_MISMATCH/);
  await fs.writeFile(descriptor.file, retained);
  const unfinished = JSON.parse(await fs.readFile(path.join(stateDir, "operation.json"), "utf8")) as { outcome: unknown };
  assert.equal(unfinished.outcome, null);
  // Existing journal and helper suffice even after the release source disappears.
  await fs.unlink(path.join(dir, "fault"));
  await fs.unlink(path.join(dir, "release.json"));
  const recovered = await resumeRunner(unresolved.recoveryFile, { executionTimeoutMs: 2000 });
  assert.equal(recovered.exitCode, 1, JSON.stringify(recovered));
  assert.equal(recovered.recoveryFile, null);
  assert.equal((await host.healthProbe()).version, "1.0.0");
  await publish("2.0.0");
  await fs.writeFile(path.join(dir, "fault"), "resume-once");
  const commit = await superviseRunner({ ...common, request: request("commit") });
  assert.equal(commit.exitCode, 0, JSON.stringify(commit));
  assert.equal(commit.attempts, 2);
  assert.equal((await host.healthProbe()).version, "2.0.0");
  await publish("3.0.0");
  await fs.writeFile(path.join(dir, "fault"), "report-crash");
  const report = await superviseRunner({ ...common, request: request("report", "3.0.0") });
  assert.equal(report.exitCode, 0, JSON.stringify(report));
  assert.equal(report.response?.result, "replayed");
  // An old supervisor must replay its archive without touching the new service.
  const before = await host.healthProbe();
  const journal = await fs.readFile(path.join(stateDir, "journal.jsonl"), "utf8");
  const old = await superviseRunner({ ...common, request: { protocolVersion: 1, action: "recover",
    expected: { id: "stop-crash", targetVersion: "2.0.0" } } });
  assert.equal(old.exitCode, 1);
  assert.equal(old.response?.result, "replayed");
  assert.deepEqual(await host.healthProbe(), before);
  assert.equal(await fs.readFile(path.join(stateDir, "journal.jsonl"), "utf8"), journal);
  assert.deepEqual((await fs.readFile(path.join(dir, "fetches"), "utf8")).trim().split("\n"),
    ["2.0.0", "2.0.0", "2.0.0", "2.0.0", "3.0.0"], "recovery must never fetch/retry the requested upgrade");

  // The old worker dies while a real controller is still capable of stopping
  // the service. A successor must not overlap that pending effect.
  let controller = await fs.readFile(path.join(dir, "controller.mjs"), "utf8");
  controller = controller.replace("case 'stop':", `case 'stop':
    if (request.slot === 'stable') {
      await (await import('node:fs/promises')).writeFile(join(dir, 'controller-live'), String(process.pid));
      for (;;) { try { await readFile(join(dir, 'release-controller')); break; } catch {} await sleep(20); }
    }`);
  await fs.writeFile(path.join(dir, "controller.mjs"), controller);
  await publish("4.0.0");
  const pending = superviseRunner({ ...common, request: request("orphan", "4.0.0"), executionTimeoutMs: 1500,
    recoveryTimeoutMs: 200, recoveryAttempts: 1 });
  await until(() => fs.stat(path.join(dir, "controller-live")).then(() => true, () => false));
  const orphanPid = Number(await fs.readFile(path.join(dir, "controller-live"), "utf8"));
  const orphan = await pending;
  assert.equal(orphan.exitCode, 3, JSON.stringify(orphan));
  assert.ok(orphan.recoveryFile);
  assert.ok(platformOpsFor().isProcessAlive(orphanPid));
  assert.equal((await host.healthProbe()).version, "3.0.0", "recovery cannot stop/start while old controller is live");
  await fs.writeFile(path.join(dir, "release-controller"), "go");
  await until(async () => !platformOpsFor().isProcessAlive(orphanPid));
  const drained = await resumeRunner(orphan.recoveryFile, { executionTimeoutMs: 2000 });
  assert.equal(drained.exitCode, 1, JSON.stringify(drained));
  assert.equal((await host.healthProbe()).version, "3.0.0");
  // Lose the entire invocation (supervisor and worker), then start NEW work.
  // The old dirty transaction must settle first; its target is not retried.
  await fs.rm(path.join(dir, "stopped"), { force: true });
  await fs.writeFile(path.join(dir, "fault"), "stop-hang");
  const supervisorSource = new URL("./supervise.ts", import.meta.url).href;
  const supervisor = spawn(process.execPath, ["--input-type=module", "--eval", `
    import {superviseRunner} from ${JSON.stringify(supervisorSource)};
    await superviseRunner(${JSON.stringify({ ...common, executionTimeoutMs: 30_000, request: request("lost-owner", "4.0.0") })});
  `], { stdio: "ignore" });
  const ownerEnded = new Promise<void>((resolve) => { supervisor.on("close", () => resolve()); });
  t.after(() => { supervisor.kill(); });
  await until(() => fs.stat(path.join(dir, "stopped")).then(() => true, () => false));
  const workerPid = Number(await fs.readFile(path.join(dir, "stopped"), "utf8"));
  supervisor.kill("SIGKILL");
  platformOpsFor().killProcess(workerPid);
  await ownerEnded;
  await until(async () => !platformOpsFor().isProcessAlive(workerPid));
  await fs.unlink(path.join(dir, "fault"));
  // Old completed operation replays while a NEWER dirty operation is pending.
  const dirtyJournal = await fs.readFile(path.join(stateDir, "journal.jsonl"), "utf8");
  const archived = await superviseRunner({ ...common, request: { protocolVersion: 1, action: "recover",
    expected: { id: "report", targetVersion: "3.0.0" } } });
  assert.equal(archived.exitCode, 0);
  assert.equal(await fs.readFile(path.join(stateDir, "journal.jsonl"), "utf8"), dirtyJournal);
  await publish("5.0.0");
  const next = await superviseRunner({ ...common, executionTimeoutMs: 4000, request: request("next", "5.0.0") });
  assert.equal(next.exitCode, 0, JSON.stringify(next));
  assert.equal((await host.healthProbe()).version, "5.0.0");
  const oldReceipt = await superviseRunner({ ...common, request: { protocolVersion: 1, action: "recover",
    expected: { id: "lost-owner", targetVersion: "4.0.0" } } });
  assert.equal(oldReceipt.exitCode, 1);
  assert.equal(oldReceipt.response?.operation.kind === "observed" && oldReceipt.response.operation.operation.outcome, "rolled-back");
  assert.deepEqual((await fs.readFile(path.join(dir, "fetches"), "utf8")).trim().split("\n").slice(-3),
    ["4.0.0", "4.0.0", "5.0.0"]);

});
