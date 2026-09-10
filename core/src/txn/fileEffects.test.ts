/** @invariant Publish durable slot bytes; a failed directory sync cannot authorize promotion. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileSlotStore } from "./fileEffects.ts";
import { platformOpsFor } from "../platform/index.ts";

async function setup(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k-slot-sync-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stable = path.join(dir, "slots", "stable");
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, "VERSION"), "1.0.0");
  await fs.writeFile(path.join(stable, "artifact.bin"), "old");
  const bytesRef = path.join(dir, "candidate");
  await fs.writeFile(bytesRef, "new");
  return { dir, stable, bytesRef, store: fileSlotStore(dir) };
}

test("slot files and staging directory are synced before publishing the slot", async (t) => {
  const { dir, bytesRef, store } = await setup(t);
  const events: string[] = [];
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, "sync", async () => { await sync(); events.push(String(args[0])); });
    return handle;
  });
  const ops = platformOpsFor();
  const syncDirectory = ops.syncDirectory.bind(ops);
  t.mock.method(ops, "syncDirectory", async (p: string) => { await syncDirectory(p); events.push(p); });
  const rename = ops.renamePath.bind(ops);
  t.mock.method(ops, "renamePath", async (from: string, to: string) => {
    const staging = path.join(dir, "slots", "experiment.staging");
    for (const p of [path.join(staging, "artifact.bin"), path.join(staging, "VERSION"), staging]) {
      assert.ok(events.includes(p), `must sync ${p} before rename`);
    }
    await rename(from, to);
  });
  await store.stageExperiment({ version: "2.0.0", bytesRef });
});

test("a failed sync after renaming stable aside stops promotion; fresh replay completes", async (t) => {
  const { dir, stable, bytesRef, store } = await setup(t);
  await store.stageExperiment({ version: "2.0.0", bytesRef });
  const ops = platformOpsFor();
  const rename = ops.renamePath.bind(ops);
  const fault = t.mock.method(ops, "renamePath", async (from: string, to: string) => {
    await rename(from, to);
    if (from === stable) throw Object.assign(new Error("directory fsync failed"), { code: "EIO" });
  });
  await assert.rejects(store.promoteExperiment(), /directory fsync failed/);
  assert.equal(await fs.readFile(path.join(`${stable}.old`, "artifact.bin"), "utf8"), "old");
  assert.equal(await fs.readFile(path.join(dir, "slots", "experiment", "artifact.bin"), "utf8"), "new");
  fault.mock.restore();
  await fileSlotStore(dir).promoteExperiment();
  assert.equal(await fs.readFile(path.join(stable, "artifact.bin"), "utf8"), "new");
  await assert.rejects(fs.stat(`${stable}.old`), { code: "ENOENT" });
});
