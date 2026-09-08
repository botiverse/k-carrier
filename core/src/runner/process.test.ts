/** @invariant External helper outlives resident replacement; receipt = real K journal outcome. */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { bootstrapStable } from "../bootstrap.ts";
import { createCommandHost } from "../lifecycle/commandHost.ts";
import type { RunnerRequest, RunnerResponse } from "../protocol/runner.ts";

const exec = promisify(execFile);
const upgrade = (id: string, targetVersion: string): RunnerRequest => ({ protocolVersion: 1,
  action: "upgrade", id, targetVersion, consented: true });
const root = fileURLToPath(new URL("../../../", import.meta.url));

test("bundled helper upgrades a real service, replays, recovers and rolls back without app upgrade code", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k-external-"));
  const stateDir = path.join(dir, "k");
  const host = createCommandHost({ stateDir, command: [process.execPath, path.join(dir, "controller.mjs"), dir] });
  t.after(async () => {
    await host.stop("stable").catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.copyFile(path.join(root, "examples/external-service/controller.mjs"), path.join(dir, "controller.mjs"));
  const template = await fs.readFile(path.join(root, "examples/external-service/service.mjs"), "utf8");
  const initial = path.join(dir, "old.mjs");
  await fs.writeFile(initial, template.replace("VERSION_PLACEHOLDER", "1.0.0"));
  await bootstrapStable({ stateDir, version: "1.0.0", artifactPath: initial });
  await host.start("stable");
  const before = await host.healthProbe();
  const helper = path.join(dir, "runner.mjs");
  await exec(process.execPath, [path.join(root, "scripts/build-runner.mjs"),
    path.join(root, "examples/external-service/adapter.ts"), helper], { cwd: root });
  async function publish(declared: string, actual = declared) {
    const bytes = Buffer.from(template.replace("VERSION_PLACEHOLDER", actual));
    await fs.writeFile(path.join(dir, "release.json"), JSON.stringify({ version: declared,
      url: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
      sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }));
  }
  async function run(request: RunnerRequest): Promise<RunnerResponse> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper], { env: { ...process.env, K_EXAMPLE_HOME: dir }, stdio: "pipe" });
      let out = ""; let err = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          const response = JSON.parse(out) as RunnerResponse;
          assert.equal(code, response.exitCode, err);
          resolve(response);
        } catch (error) { reject(new Error(`${String(error)} stdout=${out} stderr=${err}`)); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
  await publish("2.0.0");
  const success = await run(upgrade("first", "2.0.0"));
  assert.equal(success.exitCode, 0, JSON.stringify(success));
  assert.equal(success.result, "promoted");
  const after = await host.healthProbe();
  assert.equal(after.version, "2.0.0");
  assert.notEqual(after.pid, before.pid);
  assert.notEqual(after.startId, before.startId);
  assert.equal(await fs.readFile(path.join(stateDir, "slots/stable/VERSION"), "utf8"), "2.0.0");
  const journal = await fs.readFile(path.join(stateDir, "journal.jsonl"), "utf8");
  await fs.unlink(path.join(dir, "release.json"));
  assert.equal((await run(upgrade("first", "2.0.0"))).result, "replayed");
  assert.equal(await fs.readFile(path.join(stateDir, "journal.jsonl"), "utf8"), journal);
  assert.equal((await run(upgrade("first", "3.0.0"))).exitCode, 1);
  assert.equal((await run({ protocolVersion: 1, action: "status" })).operation.kind, "observed");
  await publish("3.0.0", "wrong-version");
  const failed = await run(upgrade("second", "3.0.0"));
  assert.equal(failed.result, "rolled-back", JSON.stringify(failed));
  assert.equal(failed.exitCode, 1);
  assert.equal((await host.healthProbe()).version, "2.0.0");
  assert.equal((await run({ protocolVersion: 1, action: "recover" })).exitCode, 1); // recovered rollback remains failure
  const oldReplay = await run(upgrade("first", "2.0.0"));
  assert.equal(oldReplay.result, "replayed");
  assert.equal(oldReplay.exitCode, 0);
  assert.equal((await host.healthProbe()).version, "2.0.0");
  await publish("4.0.0");
  const crashHelper = path.join(dir, "crash-runner.mjs");
  await exec(process.execPath, [path.join(root, "scripts/build-runner.mjs"),
    path.join(root, "harness/src/fixtures/externalCrashAdapter.ts"), crashHelper], { cwd: root });
  await fs.writeFile(path.join(dir, "pause"), "pause-after-stop");
  const crashed = spawn(process.execPath, [crashHelper], { env: { ...process.env, K_EXAMPLE_HOME: dir }, stdio: "pipe" });
  const ended = new Promise<void>((resolve) => { crashed.once("close", () => resolve()); });
  t.after(() => { crashed.kill(); });
  crashed.stdin.end(JSON.stringify(upgrade("interrupted", "4.0.0")));
  let stopped = false;
  for (let i = 0; i < 200; i++) {
    stopped = await fs.stat(path.join(dir, "stopped")).then(() => true, () => false);
    if (stopped) break;
    await sleep(20);
  }
  assert.equal(stopped, true, "helper must reach the stop/start crash boundary");
  await assert.rejects(host.healthProbe());
  const blocked = await run(upgrade("concurrent", "4.0.0"));
  assert.notEqual(blocked.exitCode, 0);
  crashed.kill("SIGKILL");
  await ended;
  await fs.unlink(path.join(dir, "pause"));
  await fs.unlink(path.join(dir, "release.json")); // recovery must not need distribution access
  const recovery = await run({ protocolVersion: 1, action: "recover" });
  assert.equal(recovery.exitCode, 1, JSON.stringify(recovery));
  assert.equal(recovery.operation.kind, "observed");
  if (recovery.operation.kind === "observed") assert.equal(recovery.operation.operation.outcome, "rolled-back");
  assert.equal((await host.healthProbe()).version, "2.0.0");
  const replay = await run(upgrade("interrupted", "4.0.0"));
  assert.equal(replay.result, "replayed", JSON.stringify(replay));
});
