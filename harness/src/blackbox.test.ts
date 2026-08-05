// @invariant — black-box --bin mode: contract checks (k.json, version
// command, self-upgrade loop, status schema) assert from OUTSIDE the
// binary: exit codes, on-disk bytes, next-run version.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import {
  loadKJson,
  defaultKJson,
  validateStatusOutput,
  runBinMode,
  DEFAULT_TARGET_VERSION,
} from "./blackbox.ts";
import { ArtifactFactory } from "./artifact-factory/factory.ts";
import { createSandbox } from "./scenario/sandbox.ts";
import { FakeServer } from "./fake-server/server.ts";
import { runCommand } from "./artifact-factory/run.ts";

async function buildDemoBinary(dir: string, version: string): Promise<string> {
  const sb = await createSandbox({ prefix: "demo-bin" });
  const factory = new ArtifactFactory({ cacheDir: path.join(sb.dir, "cache") });
  const store = new FakeServer({ storeDir: path.join(sb.dir, "store") });
  await store.start();
  try {
    const rel = await factory.makeRelease({ version, behavior: "ok", store: store.store });
    const binPath = path.join(dir, "mytool");
    await fs.writeFile(binPath, rel.artifactBytes, { mode: 0o755 });
    return binPath;
  } finally {
    await store.stop();
    await sb.teardown();
  }
}

test("k.json defaults and loading", async () => {
  assert.deepEqual(defaultKJson(), { version: ["--version"], selfUpgrade: ["self", "upgrade"] });
  const sb = await createSandbox({ prefix: "kjson" });
  try {
    assert.deepEqual(await loadKJson(sb.dir), defaultKJson()); // no k.json -> defaults
    await fs.writeFile(
      path.join(sb.dir, "k.json"),
      JSON.stringify({ version: ["-V"], status: ["k-status", "--json"], selfUpgrade: ["up"] }),
    );
    assert.deepEqual(await loadKJson(sb.dir), {
      version: ["-V"],
      status: ["k-status", "--json"],
      selfUpgrade: ["up"],
    });
    await fs.writeFile(path.join(sb.dir, "k.json"), JSON.stringify({ version: "not-an-array" }));
    await assert.rejects(loadKJson(sb.dir), /CONTRACT_KJSON_MALFORMED/);
  } finally {
    await sb.teardown();
  }
});

test("status schema validator accepts the canonical shape and rejects violations", () => {
  const good = {
    ProcessEvidence: { version: "1.2.3", pid: 42, startId: "inc:1" },
    TxnState: { phase: "idle", stableVersion: "1.2.3", experimentVersion: null, rollbackReason: null },
    ConvergenceReport: {
      binaryAtTarget: { passed: true, source: "probe", observedAtMs: 1, detail: {} },
      hostLifecycleConverged: { passed: false, source: "login-item", observedAtMs: 1, detail: { why: "x" } },
    },
  };
  assert.equal(validateStatusOutput(JSON.stringify(good)), null);
  assert.match(validateStatusOutput("not json")!, /not valid JSON/);
  assert.match(validateStatusOutput(JSON.stringify({ ...good, TxnState: { phase: "bogus" } }))!, /phase/);
  assert.match(validateStatusOutput(JSON.stringify({ ...good, ProcessEvidence: { version: 1 } }))!, /version/);
});

test("bin mode: full upgrade loop against the factory-built demo binary", async () => {
  const sb = await createSandbox({ prefix: "bin-e2e" });
  try {
    const binPath = await buildDemoBinary(sb.dir, "1.0.0");
    assert.equal((await runCommand(binPath, ["--version"])).stdout.trim(), "1.0.0");

    const receipt = await runBinMode({ binPath, profile: "cli", targetVersion: "9.9.9" });
    assert.equal(receipt.result, "pass", JSON.stringify(receipt.checks, null, 2));
    const byId = new Map(receipt.checks.map((c) => [c.id, c] as const));
    assert.equal(byId.get("contract.kjson-declarations")!.status, "pass");
    assert.equal(byId.get("contract.version-command")!.status, "pass");
    assert.equal(byId.get("contract.self-upgrade")!.status, "pass");
    assert.equal(byId.get("contract.status-schema")!.status, "na"); // cli demo declares no status

    // external proof: the binary on disk is now the 9.9.9 artifact
    assert.equal((await runCommand(binPath, ["--version"])).stdout.trim(), "9.9.9");
  } finally {
    await sb.teardown();
  }
});

test("bin mode: a binary whose commands fail produces a typed FAIL", async () => {
  const sb = await createSandbox({ prefix: "bin-fail" });
  try {
    // a genuinely broken "binary": every command exits 1 with a message
    const binPath = path.join(sb.dir, "mytool");
    await fs.writeFile(binPath, "#!/bin/sh\necho boom >&2\nexit 1\n", { mode: 0o755 });
    const receipt = await runBinMode({ binPath, profile: "cli" });
    assert.equal(receipt.result, "fail");
    const version = receipt.checks.find((c) => c.id === "contract.version-command")!;
    assert.equal(version.status, "fail");
    assert.match(version.error!, /CONTRACT_CMD_EXIT/);
    const upgrade = receipt.checks.find((c) => c.id === "contract.self-upgrade")!;
    assert.equal(upgrade.status, "fail");
    assert.match(upgrade.error!, /CONTRACT_CMD_EXIT/);
  } finally {
    await sb.teardown();
  }
});

test("bin mode: a missing binary is a typed FAIL, not a crash", async () => {
  const sb = await createSandbox({ prefix: "bin-missing" });
  try {
    const receipt = await runBinMode({ binPath: path.join(sb.dir, "nope"), profile: "cli" });
    assert.equal(receipt.result, "fail");
    const present = receipt.checks.find((c) => c.id === "contract.binary-present")!;
    assert.equal(present.status, "fail");
    assert.match(present.error!, /CONTRACT_BIN_MISSING/);
  } finally {
    await sb.teardown();
  }
});

test("bin mode: malformed k.json is a typed FAIL and stops the run", async () => {
  const sb = await createSandbox({ prefix: "bin-kjson" });
  try {
    const binPath = await buildDemoBinary(sb.dir, "1.0.0");
    await fs.writeFile(path.join(sb.dir, "k.json"), JSON.stringify({ version: 42 }));
    const receipt = await runBinMode({ binPath, profile: "cli" });
    assert.equal(receipt.result, "fail");
    const decl = receipt.checks.find((c) => c.id === "contract.kjson-declarations")!;
    assert.equal(decl.status, "fail");
    assert.match(decl.error!, /CONTRACT_KJSON_MALFORMED/);
    // run stops after the declaration failure (only the guards precede it)
    assert.deepEqual(
      receipt.checks.map((c) => c.id),
      ["contract.binary-present", "contract.binary-executable", "contract.kjson-declarations"],
    );
  } finally {
    await sb.teardown();
  }
});

test("bin mode: default target version is served when not specified", async () => {
  const sb = await createSandbox({ prefix: "bin-default" });
  try {
    const binPath = await buildDemoBinary(sb.dir, "1.0.0");
    const receipt = await runBinMode({ binPath, profile: "cli" });
    assert.equal(receipt.result, "pass");
    assert.equal((await runCommand(binPath, ["--version"])).stdout.trim(), DEFAULT_TARGET_VERSION);
  } finally {
    await sb.teardown();
  }
});
