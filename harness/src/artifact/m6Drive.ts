/**
 * M6 drive + policy-gate acceptance checks (test-plan M6 rows). Server-
 * pushed commands pass the SAME gates as local ones, never a bypass. The
 * rollback PAIR mutually controls: a pushed rollback of a promoted version
 * holds under confirm; K's own in-transaction auto-rollback never asks for
 * consent. The ownership gate is drawn on the ACTION'S NATURE: settling an
 * in-flight transaction is always allowed; only NEW modification of a
 * machine at rest managed elsewhere is refused.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { type ToothContext } from "../teeth/registry.ts";
import { fileProvenanceJournal } from "../../../core/src/provenance/journal.ts";
import { fileJournalStore, fileSlotStore } from "../../../core/src/txn/fileEffects.ts";
import { systemClock } from "../../../core/src/clock.ts";
import {
  holdingRollback,
  gatedAutoRollbackUpgrader,
  versionRoutingSource,
  wrongVersionSource,
} from "./m6DriveMutations.ts";
import { serveRelease } from "./m1.ts";
import { stateDir, hostReporting, makeUpgrader } from "./m6.ts";

const DRIVE = { who: "fleet-control", carrier: "example-host" };

function provDir(ctx: ToothContext): string {
  return path.join(stateDir(ctx), "provenance");
}

async function assertZeroDiskSideEffects(ctx: ToothContext): Promise<void> {
  const dir = stateDir(ctx);
  try {
    await fs.access(dir);
  } catch {
    return;
  }
  for (const p of ["journal.jsonl", "slots", "incoming", path.join("provenance", "provenance.jsonl")]) {
    await assert.rejects(fs.access(path.join(dir, p)), `${p} must not exist`);
  }
}

// ---------------------------------------------------------------------------
// m6.drive-stage-through-policy
// ---------------------------------------------------------------------------

export async function checkM6DriveStageThroughPolicy(
  ctx: ToothContext,
  opts: { stageWithoutConsent?: boolean; journalHeldStage?: boolean } = {},
): Promise<void> {
  const journal = fileProvenanceJournal(provDir(ctx), systemClock);
  const server = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "target" });
  try {
    // mutation stageWithoutConsent: the drive path stages under confirm
    // without consent (the wrong policy wiring) — the HOLD assertion reds.
    const upgrader = await makeUpgrader(ctx, server, journal, { policy: opts.stageWithoutConsent ? "auto" : "confirm" });
    const outcome = await upgrader.upgradeTo("2.0.0", { provenance: DRIVE });
    assert.equal(
      outcome.result,
      "held",
      "a drive stage under policy=confirm without consent is a HOLD, never a stage (stageWithoutConsent => RED)",
    );
    await assertZeroDiskSideEffects(ctx);
    // mutation journalHeldStage: a held stage is recorded as a reconcile —
    // the genesis assertion reds (a held stage never reached the txn).
    const read = opts.journalHeldStage ? { kind: "observed" as const, entries: [] } : await journal.read();
    assert.equal(
      read.kind,
      "genesis",
      "a held drive stage is not a reconcile — the provenance journal stays untouched (journalHeldStage => RED)",
    );
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// m6.drive-promote-through-policy
// ---------------------------------------------------------------------------

export async function checkM6DrivePromoteThroughPolicy(
  ctx: ToothContext,
  opts: { promoteWithoutConsent?: boolean; installOtherVersion?: boolean } = {},
): Promise<void> {
  const journal = fileProvenanceJournal(provDir(ctx), systemClock);
  const server = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "target" });
  const other = await serveRelease(ctx, { version: "3.0.0", behavior: "ok", name: "other" });
  try {
    // mutation promoteWithoutConsent: policy auto — the drive promotes
    // without consent, and the HOLD assertion reds.
    const upgrader = await makeUpgrader(ctx, server, journal, { policy: opts.promoteWithoutConsent ? "auto" : "confirm" });

    const held = await upgrader.upgradeTo("2.0.0", { provenance: DRIVE });
    assert.equal(
      held.result,
      "held",
      "a drive promote under policy=confirm without consent is a HOLD (promoteWithoutConsent => RED)",
    );

    // mutation installOtherVersion: the source serves 3.0.0 for a 2.0.0
    // request — consent binds a SPECIFIC version; the exactly-approved
    // assertion reds.
    const consentedUpgrader = opts.installOtherVersion
      ? await makeUpgrader(ctx, other, journal, {
          host: hostReporting("3.0.0"),
          policy: "confirm",
          source: wrongVersionSource(other),
        })
      : upgrader;
    const outcome = await consentedUpgrader.upgradeTo("2.0.0", { consented: true, provenance: DRIVE });
    assert.equal(outcome.result, "promoted", "with consent the drive promote installs");
    assert.equal(
      outcome.report?.version,
      "2.0.0",
      "the drive installs exactly the approved version — consent binds (installOtherVersion => RED)",
    );

    // the provenance records who drove it
    const read = await journal.read();
    assert.equal(read.kind, "observed");
    if (read.kind !== "observed") return;
    const e = read.entries.at(-1);
    assert.equal(e?.who, "fleet-control", "the provenance records the driving identity");
    assert.equal(e?.version, "2.0.0", "the provenance records the version that was installed");
  } finally {
    await server.stop();
    await other.stop();
  }
}

// ---------------------------------------------------------------------------
// m6.drive-rollback-through-ownership
// ---------------------------------------------------------------------------

export async function checkM6DriveRollbackThroughOwnership(
  ctx: ToothContext,
  opts: { rollbackIgnoringOwnership?: boolean } = {},
): Promise<void> {
  const journal = fileProvenanceJournal(provDir(ctx), systemClock);
  const server = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "target" });
  const dir = stateDir(ctx);
  try {
    // Every TERMINAL state (idle/promoted/rolled-back) is at rest: the
    // gate enumerates positively over phases, so the next terminal phase
    // cannot silently become "in flight" (an exclusion list would touch a
    // machine that is not ours). All three are asserted, not patched one.
    for (const terminal of ["idle", "promoted", "rolled-back"] as const) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      if (terminal !== "idle") {
        const store = fileJournalStore(dir);
        await store.appendAndSync({ seq: 0, timestampMs: 1, intent: terminal, detail: {} });
      }
      // mutation rollbackIgnoringOwnership: ownership is self — the
      // rollback proceeds, and the typed-held assertion reds.
      const upgrader = await makeUpgrader(ctx, server, journal, {
        installOwnership: opts.rollbackIgnoringOwnership ? () => "self" : () => "managed-elsewhere",
      });
      const outcome = await upgrader.rollback("user requested");
      assert.ok(
        typeof outcome === "object" && outcome.held.includes("managed"),
        `a drive rollback on a managed-elsewhere machine at terminal '${terminal}' is a typed held, never a rollback of someone else's copy (rollbackIgnoringOwnership => RED)`,
      );
      const st = await upgrader.state();
      assert.equal(st.experimentVersion, null, `terminal '${terminal}': nothing was rolled back`);
      const intents = (await fileJournalStore(dir).readAll()).map((e) => e.intent);
      assert.equal(intents.length, terminal === "idle" ? 0 : 1, `terminal '${terminal}': held appended nothing`);
    }
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// m6.rollback-settles-inflight-ownership-flip
// ---------------------------------------------------------------------------

export async function checkM6RollbackSettlesInflightOwnershipFlip(
  ctx: ToothContext,
  opts: { holdInFlightRollback?: boolean } = {},
): Promise<void> {
  const journal = fileProvenanceJournal(provDir(ctx), systemClock);
  const server = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "target" });
  const dir = stateDir(ctx);
  try {
    // Simulate a crash mid-transaction: a staged intent is durable
    // (write-ahead) and the experiment slot holds the staged bytes — K
    // opened this transaction when ownership was self; ownership has since
    // flipped. The machine MUST settle, never hold: a held here is a brick.
    const store = fileJournalStore(dir);
    await store.appendAndSync({ seq: 0, timestampMs: 1, intent: "staged", detail: { version: "2.0.0" } });
    const dummy = path.join(ctx.sandboxDir, "dummy.bin");
    await fs.writeFile(dummy, "staged-bytes");
    await fileSlotStore(dir).stageExperiment({ version: "2.0.0", bytesRef: dummy });

    const upgrader = await makeUpgrader(ctx, server, journal, {
      installOwnership: () => "managed-elsewhere",
    });
    const outcome = opts.holdInFlightRollback
      ? await holdingRollback(await upgrader).rollback("settle")
      : await (await upgrader).rollback("settle");
    assert.equal(
      outcome,
      "rolled-back",
      "an in-flight transaction settles even when ownership flipped — a held mid-transaction is a brick (holdInFlightRollback => RED)",
    );
    const st = await upgrader.state();
    assert.equal(st.experimentVersion, null, "the machine converges to a safe phase");
    const intents = (await store.readAll()).map((e) => e.intent);
    assert.equal(intents.at(-1), "rolled-back", "the transaction is settled, journal resolved");
  } finally {
    await server.stop();
  }
}
// ---------------------------------------------------------------------------
// m6.push-rollback-through-policy
// ---------------------------------------------------------------------------

export async function checkM6PushRollbackThroughPolicy(
  ctx: ToothContext,
  opts: { bypassPushRollbackPolicy?: boolean } = {},
): Promise<void> {
  const journal = fileProvenanceJournal(provDir(ctx), systemClock);
  const server = await serveRelease(ctx, { version: "1.0.0", behavior: "ok", name: "seed" });
  const target = await serveRelease(ctx, { version: "2.0.0", behavior: "ok", name: "target" });
  try {
    // Promote 2.0.0 with consent: 2.0.0 is now the RUNNING version. The
    // source routes by version so the later push-rollback to 1.0.0 is
    // served by the seed.
    const routed = versionRoutingSource({ "1.0.0": server, "2.0.0": target });
    const upgrader = await makeUpgrader(ctx, target, journal, { policy: "confirm", source: routed });
    const promote = await upgrader.upgradeTo("2.0.0", { consented: true, provenance: DRIVE });
    assert.equal(promote.result, "promoted", "the consented promote lands");
    // mutation bypassPushRollbackPolicy: policy auto — the push-rollback
    // path skips the confirm gate, and the HOLD assertion reds.
    const downgradeUpgrader = opts.bypassPushRollbackPolicy
      ? await makeUpgrader(ctx, target, journal, { policy: "auto", source: routed })
      : upgrader;
    // A server-pushed rollback of an ALREADY-PROMOTED version is a NEW
    // change to a running system — same nature as an upgrade: under
    // policy=confirm it must HOLD until consent. "Safe direction" is byte
    // safety, NOT authority: a bypassable push-rollback is the downgrade
    // attack by another name.
    const outcome = await downgradeUpgrader.upgradeTo("1.0.0", { provenance: DRIVE });
    assert.equal(
      outcome.result,
      "held",
      "a pushed rollback of a promoted version under confirm without consent is a HOLD (bypassPushRollbackPolicy => RED)",
    );
    const st = await upgrader.state();
    assert.equal(st.stableVersion, "2.0.0", "the running version was not rolled back without consent");
  } finally {
    await server.stop();
    await target.stop();
  }
}

// ---------------------------------------------------------------------------
// m6.auto-rollback-needs-no-consent
// ---------------------------------------------------------------------------

export async function checkM6AutoRollbackNeedsNoConsent(
  ctx: ToothContext,
  opts: { gateAutoRollback?: boolean } = {},
): Promise<void> {
  const journal = fileProvenanceJournal(provDir(ctx), systemClock);
  const target = await serveRelease(ctx, { version: "3.0.0", behavior: "ok", name: "bad" });
  const events: Array<{ kind: string; detail: Record<string, string> }> = [];
  const sink = async (e: { kind: string; detail: Record<string, string> }): Promise<void> => {
    events.push(e);
  };
  try {
    // The upgrade itself is consented; the bad successor cannot start, so
    // the ENGINE auto-rolls back. That rollback is part of the already-
    // consented upgrade — the fulfillment of "you'll always get back" —
    // and must NEVER ask for consent, even under policy=confirm.
    const upgrader = await makeUpgrader(ctx, target, journal, { policy: "confirm", notificationSink: sink });
    const executor = opts.gateAutoRollback ? gatedAutoRollbackUpgrader(upgrader, sink) : upgrader;
    const outcome = await executor.upgradeTo("3.0.0", { consented: true, provenance: DRIVE });
    assert.equal(
      outcome.result,
      "rolled-back",
      "the in-transaction auto-rollback must happen — it fulfills 'you'll always get back' (gateAutoRollback => RED)",
    );
    assert.ok(
      !events.some((e) => e.kind === "confirm-request"),
      "the auto-rollback must never ask for consent — it is part of the already-consented upgrade (gateAutoRollback => RED)",
    );
    const st = await upgrader.state();
    assert.equal(st.stableVersion, "0.0.0", "the machine is back at the old version, nothing promoted");
  } finally {
    await target.stop();
  }
}

