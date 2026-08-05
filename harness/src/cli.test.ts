// @invariant — k-harness CLI contract: mode dispatch, receipt output, exit
// code = 0 iff pass; profile/adapter/bin modes all work end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { runCommand } from "./artifact-factory/run.ts";
import { ArtifactFactory } from "./artifact-factory/factory.ts";
import { createSandbox } from "./scenario/sandbox.ts";
import { FakeServer } from "./fake-server/server.ts";

const CLI_PATH = path.join(import.meta.dirname, "cli.ts");

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // The service tier runs real-process upgrades (m3 teeth) — generous.
  const r = await runCommand(process.execPath, [CLI_PATH, ...args], { timeoutMs: 120000 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

test("--profile swap runs the cli-tier teeth and exits 0", async () => {
  const { code, stdout } = await runCli(["--profile", "swap"]);
  assert.equal(code, 0, stdout + "\n---\n" + (await runCli(["--profile", "swap"])).stderr);
  assert.match(stdout, /result: pass/);
  assert.match(stdout, /fake-server\.tamper-corrupt-byte/);
  assert.match(stdout, /artifact-factory\.ok-artifact-runs/);
});

test("--profile hosted runs the daemon/managed teeth too", async () => {
  const { code, stdout } = await runCli(["--profile", "service", "--json"]);
  assert.equal(code, 0);
  const receipt = JSON.parse(stdout) as {
    checks: Array<{ id: string; status: string }>;
    summary: { pass: number; fail: number; total: number };
  };
  assert.ok(receipt.checks.some((c) => c.id === "fake-host.ledger-equivalence-after-rollback"));
  assert.equal(receipt.summary.fail, 0);
  assert.ok(receipt.summary.total > 0);
});

test("--bin mode upgrades a factory-built binary end to end", async () => {
  const sb = await createSandbox({ prefix: "cli-bin" });
  try {
    // build the demo binary + its k.target.ts into the sandbox
    const factory = new ArtifactFactory({ cacheDir: path.join(sb.dir, "cache") });
    const server = new FakeServer({ storeDir: path.join(sb.dir, "store") });
    await server.start();
    try {
      const rel = await factory.makeRelease({ version: "1.0.0", behavior: "ok", store: server.store });
      const binPath = path.join(sb.dir, "mytool");
      await fs.writeFile(binPath, rel.artifactBytes, { mode: 0o755 });
      await fs.writeFile(
        path.join(sb.dir, "k.target.ts"),
        `export default { version: ["--version"], selfUpgrade: ["self", "upgrade"] };\n`,
      );
      const { code, stdout } = await runCli(["--bin", binPath, "--target-version", "7.7.7"]);
      assert.equal(code, 0, stdout);
      assert.match(stdout, /contract\.version-command/);
      assert.match(stdout, /contract\.self-upgrade/);
      assert.match(stdout, /result: pass/);
      // the binary really upgraded on disk
      const v = await runCommand(binPath, ["--version"]);
      assert.equal(v.stdout.trim(), "7.7.7");
    } finally {
      await server.stop();
    }
  } finally {
    await sb.teardown();
  }
});

test("--bin mode failure exits 1 with a typed error in the receipt", async () => {
  const sb = await createSandbox({ prefix: "cli-bin-fail" });
  try {
    const factory = new ArtifactFactory({ cacheDir: path.join(sb.dir, "cache") });
    const server = new FakeServer({ storeDir: path.join(sb.dir, "store") });
    await server.start();
    try {
      const rel = await factory.makeRelease({ version: "1.0.0", behavior: "ok", store: server.store });
      const binPath = path.join(sb.dir, "mytool");
      await fs.writeFile(binPath, rel.artifactBytes, { mode: 0o755 });
      await fs.writeFile(
        path.join(sb.dir, "k.target.ts"),
        `export default { version: ["--version"], selfUpgrade: ["nope"] };\n`,
      );
      const { code, stdout } = await runCli(["--bin", binPath]);
      assert.equal(code, 1);
      assert.match(stdout, /result: fail/);
      assert.match(stdout, /CONTRACT_/);
    } finally {
      await server.stop();
    }
  } finally {
    await sb.teardown();
  }
});

test("--adapter mode runs the contract subset against an external adapter", async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "minimal-adapter.ts");
  const { code, stdout } = await runCli(["--adapter", fixture, "--json"]);
  assert.equal(code, 0, stdout);
  const receipt = JSON.parse(stdout) as {
    checks: Array<{ id: string; status: string }>;
    result: string;
  };
  assert.equal(receipt.result, "pass");
  const ids = receipt.checks.map((c) => c.id);
  assert.ok(ids.includes("adapter.ledger-equivalence"));
  assert.ok(ids.includes("adapter.probe-binds-current-incarnation"));
  // the contract subset passes; the service-tier checks are na (this
  // adapter declares no lifecycle surfaces)
  for (const c of receipt.checks) {
    if (c.id.startsWith("adapter.service-") || c.id.startsWith("adapter.lifecycle-")) {
      assert.equal(c.status, "na", `${c.id} must be na for a contract-only adapter`);
    } else {
      assert.equal(c.status, "pass", `${c.id} must pass`);
    }
  }
});

test("--adapter runs the service-tier teeth against a process-semantics adapter", async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "service-adapter.ts");
  const { code, stdout } = await runCli(["--adapter", fixture, "--json"]);
  assert.equal(code, 0, stdout);
  const receipt = JSON.parse(stdout) as {
    checks: Array<{ id: string; status: string }>;
    result: string;
  };
  assert.equal(receipt.result, "pass");
  const byId = new Map(receipt.checks.map((c) => [c.id, c] as const));
  assert.equal(byId.get("adapter.service-upgrade")!.status, "pass");
  assert.equal(byId.get("adapter.service-rollback")!.status, "pass");
  assert.equal(byId.get("adapter.lifecycle-converged")!.status, "pass");
  // the contract subset (inproc-driver checks) is skipped for this shape
  assert.equal(byId.get("adapter.probe-version-matches-slot")!.status, "na");
});

test("--help prints usage and exits 0; bad flags exit 2", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /k-harness/);
  const bad = await runCli(["--bogus"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown flag/);
});
