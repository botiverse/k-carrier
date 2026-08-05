/**
 * The missing-target fail-closed check (registered as
 * blackbox.missing-target-fails): a binary with NO k.target.ts must be a
 * typed BLACKBOX_TARGET_REQUIRED FAIL — the harness never guesses
 * commands. `withTarget` simulates the must-red mutation (a target file
 * exists, so the failure no longer happens) for known-red driving.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type ToothContext } from "./teeth/registry.ts";
import { ArtifactFactory } from "./artifact-factory/factory.ts";
import { FakeServer } from "./fake-server/server.ts";
import { runBinMode } from "./blackbox.ts";
import { TARGET_FILE } from "./target.ts";

export async function checkMissingTargetFails(
  ctx: ToothContext,
  opts: { withTarget?: boolean } = {},
): Promise<void> {
  const factory = new ArtifactFactory({ cacheDir: path.join(ctx.sandboxDir, "cache") });
  const server = new FakeServer({ storeDir: path.join(ctx.sandboxDir, "store") });
  await server.start();
  try {
    const rel = await factory.makeRelease({ version: "1.0.0", behavior: "ok", store: server.store });
    const appDir = path.join(ctx.sandboxDir, "app");
    await fs.mkdir(appDir, { recursive: true });
    const binPath = path.join(appDir, "mytool");
    await fs.writeFile(binPath, rel.artifactBytes, { mode: 0o755 });
    if (opts.withTarget) {
      await fs.writeFile(
        path.join(appDir, TARGET_FILE),
        `export default { version: ["--version"], selfUpgrade: ["self", "upgrade"] };`,
      );
    }
    const receipt = await runBinMode({ binPath, profile: "cli" });
    const decl = receipt.checks.find((c) => c.id === "contract.target-declarations");
    assert.ok(
      decl?.status === "fail",
      "a binary without k.target.ts must fail with an actionable typed error (no guessing)",
    );
    assert.equal(receipt.result, "fail");
    assert.match(decl?.error ?? "", /BLACKBOX_TARGET_REQUIRED/);
  } finally {
    await server.stop();
  }
}
