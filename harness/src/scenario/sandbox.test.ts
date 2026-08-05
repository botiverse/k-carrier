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
