/** @invariant Unverified helper bytes never execute; exit is observed, not inferred from spawn. */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { launchRunner } from "./launch.ts";

test("bootstrap verifies, waits for helper, and cleans only its disposable directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "k-bootstrap-"));
  try {
    const marker = path.join(dir, "executed");
    const bytes = Buffer.from(`import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'done'); process.exitCode=2;`);
    const release = { version: "helper-1", url: `data:text/javascript;base64,${bytes.toString("base64")}`,
      sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    const input = { release, request: { protocolVersion: 1, action: "status" } as const,
      scratchDir: dir, interpreter: process.execPath };
    await assert.rejects(launchRunner({ ...input, release: { ...release, sha256: "0".repeat(64) } }), /SHA256/);
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
    assert.equal(await launchRunner(input), 2);
    assert.equal(await fs.readFile(marker, "utf8"), "done");
    assert.deepEqual(await fs.readdir(dir), ["executed"]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
