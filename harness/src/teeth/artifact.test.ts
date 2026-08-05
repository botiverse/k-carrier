// @invariant — M1 artifact teeth self-verification: known-green on a clean
// world, known-red under each declared mutation.
import { test } from "node:test";

/** A source that serves ANY platform and ANY version asked for: it guesses. */
const lenientSource = (version: string) => ({
  checkForUpdate: async () => ({ version, url: "https://x/a.bin", sha256: "a".repeat(64), size: 1 }),
  fetchRelease: async (v: string) => ({ version: v, url: "https://x/a.bin", sha256: "a".repeat(64), size: 1 }),
});
import assert from "node:assert/strict";
import "./index.ts"; // registers all teeth
import { allTeeth, exportForMutationRunner, type ToothContext } from "./registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";
import {
  checkTamperedArtifactRefused,
  checkKillMidSwapPreservesOld,
  checkSourceFailsClosed,
} from "../artifact/checks.ts";
import {
  checkSwapToolUpgradeLoop,
  checkSwapToolRollback,
} from "../artifact/m1.ts";
import {
  checkM2UntrustedSignerRefused,
  checkM2TamperedArtifactRefused,
  checkM2UnsignedExplicitAccepted,
  checkM2UnsignedRefusedByDefault,
} from "../artifact/m2.ts";
import {
  checkM3ServiceUpgrade,
  checkM3ServiceRollback,
  checkM3StuckDriverEvidence,
} from "../artifact/m3.ts";
import { checkDownloadResumesAfterKill } from "../artifact/m1Resume.ts";

/**
 * Teeth whose green run lives in another file. Listing one here is a claim
 * that it IS exercised there -- not a way to skip it.
 */
const COVERED_ELSEWHERE = new Set([
  "fake-server.serves-verifiable-release",
  "fake-server.tamper-corrupt-byte",
  "fake-server.tamper-swap-sig",
  "fake-server.tamper-serve-older-version",
  "fake-server.tamper-drop-file",
  "scenario.sandbox-verify-dead",
  "scenario.sandbox-isolation",
  "artifact-factory.deterministic-build",
  "artifact-factory.ok-artifact-runs",
  "fake-host.ledger-equivalence",
  "fake-host.ledger-equivalence-after-rollback",
  "fake-host.fault-fail-on-quiesce",
  "fake-host.fault-hang-on-stop",
  "fake-host.fault-wrong-version-probe",
  "fake-host.fault-stale-startid-probe",
  "fake-host.fault-crash-during-start",
  "harness.teeth-present-swap",
  "harness.teeth-present-service",
  "examples.swap-tool-blackbox",
  "examples.service-daemon-contract",
  "examples.hosted-service-adapter", // green run: teeth/examples.test.ts
  "blackbox.missing-target-fails",
]);

const TOOTH_IDS = new Set([
  "artifact.tamper-refuses-install",
  "artifact.atomic-swap-crash-safe",
  "artifact.source-fails-closed",
  "m1.swap-tool-upgrade",
  "m1.swap-tool-rollback",
  "m2.untrusted-signer-refused",
  "m2.tampered-artifact-refused",
  "m2.unsigned-explicit-accepted",
  "m2.unsigned-refused-by-default",
  "m3.service-upgrade",
  "m3.service-rollback",
  "m3.stuck-driver-evidence-recovery",
  "m1.download-resumes-after-kill",
]);

async function ctxFor(prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
}

test("known-green: every artifact/milestone tooth passes on a clean sandbox", async () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  // Both directions, because each catches a different mistake:
  //  - a listed id that nothing registers => the list rots
  //  - a registered artifact tooth missing from the list => it silently never
  //    runs here, which is the false-green this whole file exists to prevent.
  assert.equal(teeth.length, TOOTH_IDS.size, "every listed id must be registered");
  // Fail CLOSED on new teeth. The previous version enumerated known prefixes
  // (artifact|m1|m2), so the moment m3 landed its teeth were silently absent
  // from the green run -- only their known-red tests executed them, and those
  // pass whether or not the assertions mean anything. A guard that lists the
  // names it knows about stops guarding exactly when something new arrives.
  const unlisted = allTeeth()
    .map((t) => t.id)
    .filter((id) => !TOOTH_IDS.has(id) && !COVERED_ELSEWHERE.has(id));
  assert.deepEqual(unlisted, [], "every registered tooth must run green somewhere");
  for (const tooth of teeth) {
    const { ctx, teardown } = await ctxFor(tooth.id.replaceAll(".", "-"));
    try {
      await tooth.run(ctx);
    } catch (err) {
      assert.fail(`tooth ${tooth.id} went RED on a clean world: ${(err as Error).message}`);
    } finally {
      await teardown();
    }
  }
});

test("known-red: tamper-refuses-install catches a verification that never happens", async () => {
  const { ctx, teardown } = await ctxFor("red-tamper");
  try {
    await assert.rejects(
      checkTamperedArtifactRefused(ctx, { skipTamper: true }),
      /must be refused/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: atomic-swap-crash-safe catches a swap that completes (no kill)", async () => {
  const { ctx, teardown } = await ctxFor("red-swap");
  try {
    await assert.rejects(
      checkKillMidSwapPreservesOld(ctx, { skipKill: true }),
      /old bytes intact/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: source-fails-closed catches a source that guesses instead of refusing", async () => {
  const { ctx, teardown } = await ctxFor("red-source");
  try {
    // mutation: a source that serves ANY platform and ANY version it is asked
    // for — i.e. it guesses rather than refusing. The tooth must go red.
    await assert.rejects(checkSourceFailsClosed(ctx, lenientSource));
  } finally {
    await teardown();
  }
});

test("known-red: m1.swap-tool-upgrade catches an upgrade that never lands", async () => {
  const { ctx, teardown } = await ctxFor("red-m1-upgrade");
  try {
    // mutation: a bad version is served — the upgrade rolls back, so the
    // "self upgrade must exit 0 / next run must report" assertions go RED
    await assert.rejects(checkSwapToolUpgradeLoop(ctx, { serveBadVersion: true }), /must exit 0|must report/);
  } finally {
    await teardown();
  }
});

test("known-red: m1.swap-tool-rollback catches a promoted bad version", async () => {
  const { ctx, teardown } = await ctxFor("red-m1-rollback");
  try {
    // mutation: a GOOD version is served — it promotes, so the rollback
    // expectation goes RED
    await assert.rejects(checkSwapToolRollback(ctx, { serveGoodVersion: true }), /must roll back/);
  } finally {
    await teardown();
  }
});

test("known-red: m2.untrusted-signer-refused catches a trusted attacker root", async () => {
  const { ctx, teardown } = await ctxFor("red-m2-signer");
  try {
    // mutation: the attacker's root is added to the trusted set — the
    // compromised release installs, so the refusal assertion goes RED
    await assert.rejects(checkM2UntrustedSignerRefused(ctx, { trustAttacker: true }), /must not land/);
  } finally {
    await teardown();
  }
});

test("known-red: m2.tampered-artifact-refused catches an untouched artifact", async () => {
  const { ctx, teardown } = await ctxFor("red-m2-tamper");
  try {
    // mutation: no tamper — the 2.0.0 installs, so the refusal goes RED
    await assert.rejects(checkM2TamperedArtifactRefused(ctx, { skipTamper: true }), /must not land/);
  } finally {
    await teardown();
  }
});

test("known-red: m3.service-upgrade catches an upgrade that never lands (both host shapes)", async () => {
  const { ctx, teardown } = await ctxFor("red-m3-upgrade");
  try {
    // mutation: a bad version is served — it rolls back, so the fresh
    // incarnation assertion goes RED on both host shapes
    await assert.rejects(checkM3ServiceUpgrade(ctx, { serveBadVersion: true }), /must exit 0/);
  } finally {
    await teardown();
  }
});

test("known-red: m3.service-rollback catches a promoted good version (both host shapes)", async () => {
  const { ctx, teardown } = await ctxFor("red-m3-rollback");
  try {
    // mutation: a GOOD version is served — it promotes, so the rollback
    // expectation goes RED on both host shapes
    await assert.rejects(checkM3ServiceRollback(ctx, { serveGoodVersion: true }), /must roll back/);
  } finally {
    await teardown();
  }
});

test("known-red: m1.download-resumes-after-kill catches a restart-from-zero downloader", async () => {
  const { ctx, teardown } = await ctxFor("red-m1-resume");
  try {
    // mutation: the second download uses a FRESH resume dir — no partial,
    // no Range — so the resume assertion goes RED
    await assert.rejects(checkDownloadResumesAfterKill(ctx, { skipResume: true }), /must issue a Range/);
  } finally {
    await teardown();
  }
});

test("known-red: m3.stuck-driver-evidence-recovery catches a successor that never recovers", async () => {
  const { ctx, teardown } = await ctxFor("red-m3-stuck");
  try {
    // mutation: the successor skips recovery — the transaction stays
    // pending at handing-over, so the promoted assertion goes RED
    await assert.rejects(checkM3StuckDriverEvidence(ctx, { skipRecovery: true }), /must finish the transaction/);
  } finally {
    await teardown();
  }
});

test("known-red: m2.unsigned-explicit-accepted catches a signed release", async () => {
  const { ctx, teardown } = await ctxFor("red-m2-unsigned");
  try {
    // mutation: a SIGNED release is served — no unsigned record, so the
    // unverified-notification assertion goes RED
    await assert.rejects(checkM2UnsignedExplicitAccepted(ctx, { serveSigned: true }));
  } finally {
    await teardown();
  }
});

test("known-red: m2.unsigned-refused-by-default catches a client that accepts", async () => {
  const { ctx, teardown } = await ctxFor("red-m2-default");
  try {
    // mutation: the CLIENT accepts unattributable bytes (K_ACCEPT_UNSIGNED=1),
    // so the unsigned release installs and the refusal assertion goes RED.
    // This is what makes the tooth non-vacuous: without it, "refuses unsigned"
    // and "refuses nothing" would look the same.
    await assert.rejects(
      checkM2UnsignedRefusedByDefault(ctx, { clientAccepts: true }),
      /must NOT install/,
    );
  } finally {
    await teardown();
  }
});

test("registration discipline: profiles/layers/kind/mustRed all answered", () => {
  const teeth = allTeeth().filter((t) => TOOTH_IDS.has(t.id));
  for (const tooth of teeth) {
    assert.ok(tooth.profiles.length > 0, `${tooth.id}: profiles`);
    assert.ok(tooth.layers.length > 0, `${tooth.id}: layers`);
    assert.equal(tooth.kind.kind, "invariant", `${tooth.id}: kind`);
    assert.ok(tooth.mustRed.length > 0, `${tooth.id}: must-red`);
    for (const mr of tooth.mustRed) {
      assert.ok(mr.mutate.trim(), `${tooth.id}: mutation text`);
      assert.ok(
        mr.caughtOnlyBy === "this" ||
          (mr.caughtOnlyBy.alsoCaughtBy.trim() && mr.caughtOnlyBy.whyStillNeeded.trim()),
        `${tooth.id}: caughtOnlyBy answered`,
      );
    }
  }
  const exported = new Map(exportForMutationRunner().map((e) => [e.id, e]));
  for (const id of TOOTH_IDS) {
    assert.ok(exported.has(id), `${id} must be in the mutation-runner export`);
  }
});

test("tooth run functions are the exported checks (single source of truth)", () => {
  const byId = new Map(allTeeth().map((t) => [t.id, t] as const));
  assert.equal(byId.get("artifact.tamper-refuses-install")!.run, checkTamperedArtifactRefused);
  assert.equal(byId.get("artifact.atomic-swap-crash-safe")!.run, checkKillMidSwapPreservesOld);
  assert.equal(byId.get("artifact.source-fails-closed")!.run, checkSourceFailsClosed);
  assert.equal(byId.get("m1.swap-tool-upgrade")!.run, checkSwapToolUpgradeLoop);
  assert.equal(byId.get("m1.swap-tool-rollback")!.run, checkSwapToolRollback);
  assert.equal(byId.get("m2.untrusted-signer-refused")!.run, checkM2UntrustedSignerRefused);
  assert.equal(byId.get("m2.tampered-artifact-refused")!.run, checkM2TamperedArtifactRefused);
  assert.equal(byId.get("m2.unsigned-explicit-accepted")!.run, checkM2UnsignedExplicitAccepted);
});
