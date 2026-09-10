/** @invariant Every bundle format exits after its response, even with live adapter handles. */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));

for (const format of ["esm", "cjs"]) {
  test(`${format} runner flushes its response and exits despite an adapter timer`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k-bundle-exit-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const adapter = path.join(dir, "adapter.ts");
    const runner = path.join(dir, format === "esm" ? "runner.mjs" : "runner.cjs");
    await fs.writeFile(adapter, `export default function create() {
      setInterval(() => {}, 1000);
      return { operation: async () => ({ kind: "genesis" }) };
    }`);
    await exec(process.execPath, [path.join(root, "scripts/build-runner.mjs"),
      ...(format === "cjs" ? ["--cjs"] : []), adapter, runner]);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [runner], { timeout: 5000 }, (error, out, stderr) => {
        if (error) reject(new Error(`runner did not exit cleanly: ${error.message}; stdout=${out}; stderr=${stderr}`));
        else resolve(out);
      });
      child.stdin!.end(JSON.stringify({ protocolVersion: 1, action: "status" }));
    });
    const response = JSON.parse(stdout);
    assert.equal(response.exitCode, 0);
    assert.equal(response.action, "status");
    assert.equal(response.operation.kind, "genesis");
  });
}
