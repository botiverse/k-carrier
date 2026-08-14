import * as path from "node:path";
import type { Release } from "../artifact/source.ts";
import { downloadVerified } from "../artifact/download.ts";
import { ArtifactError } from "../artifact/errors.ts";
import { materializeArtifact } from "../txn/fileEffects.ts";
import { acquireUpgradeLock } from "../txn/lock.ts";
import type { UpgradeEngine, EngineOutcome } from "../txn/engine.ts";
import type { Clock } from "../clock.ts";
import type { UpgradeProgress } from "../progress.ts";
import type { ProcessEvidence } from "../lifecycle/hostAdapter.ts";
import type { PredicateResult, ConvergenceReport } from "../converge/predicates.ts";
import type { OperationDescriptor } from "../operation.ts";
import type { OperationLifecycle } from "../operationLifecycle.ts";
import type {
  NotificationEvent,
  ProvenanceIdentity,
  UpgradeOutcome,
} from "../upgrader.ts";
import type { ProvenanceJournal } from "../provenance/journal.ts";
import { recordReconcile } from "../provenance/journal.ts";
import { finishUpgradeOutcome } from "./outcome.ts";

export interface UpgradeDriveDeps {
  stateDir: string;
  clock: Clock;
  engine: UpgradeEngine;
  operation: OperationLifecycle;
  ownership: () => "self" | "managed-elsewhere";
  readStableVersion: () => Promise<string>;
  policy: "auto" | "confirm" | "notify-only";
  notificationSink: (event: NotificationEvent) => Promise<void>;
  onProgress?: (progress: UpgradeProgress) => void;
  checkCompatibility?: (from: string, to: string) => Promise<string | null>;
  lifecycleSurfaceCount: number;
  evidence: () => ProcessEvidence | null;
  lifecycle: () => PredicateResult | null;
  persistConvergenceReport: (report: ConvergenceReport) => Promise<void>;
  provenanceJournal?: ProvenanceJournal;
  provenanceIdentity?: ProvenanceIdentity;
}

export interface UpgradeDriveRequest {
  pick: (current: string) => Promise<Release | null>;
  consented?: boolean;
  provenance?: ProvenanceIdentity;
  operation?: OperationDescriptor;
  targetVersionHint?: string;
}

export async function driveUpgrade(
  deps: UpgradeDriveDeps,
  request: UpgradeDriveRequest,
): Promise<UpgradeOutcome> {
  const notify = (kind: NotificationEvent["kind"], detail: Record<string, string>) =>
    deps.notificationSink({ kind, detail });
  const progress = (value: UpgradeProgress): void => {
    try { deps.onProgress?.(value); } catch { /* observation cannot fail an upgrade */ }
  };
  if (deps.ownership() === "managed-elsewhere") {
    await notify("held", { reason: "managed-elsewhere" });
    return { result: "held", reason: "this install is managed by another manager; it does not upgrade itself" };
  }

  const lock = await acquireUpgradeLock(deps.stateDir, deps.clock.nowMs());
  try {
    await deps.engine.recover();
    await deps.operation.settleRecovery();
    const current = await deps.readStableVersion();
    await deps.operation.begin(
      request.operation ?? null,
      current,
      request.targetVersionHint ?? current,
      request.provenance ?? null,
    );
    progress({ stage: "checking" });

    let release: Release | null;
    try {
      release = await request.pick(current);
    } catch (error) {
      if (request.consented && error instanceof ArtifactError && error.code === "PINNED_VERSION_MISMATCH") {
        await deps.operation.transition({ phase: "held", outcome: "held", reason: "consented-version-unavailable" });
        await notify("held", { reason: "consented-version-unavailable", version: current });
        return { result: "held", reason: "the approved version is no longer served; nothing was installed" };
      }
      await deps.operation.transition({
        phase: "failed",
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (release === null) {
      await deps.operation.transition({ phase: "up-to-date", outcome: "up-to-date" });
      return { result: "up-to-date" };
    }
    if (!request.consented && deps.policy === "notify-only") {
      await deps.operation.transition({ phase: "held", outcome: "held", reason: "notify-only" });
      await notify("held", { reason: "notify-only", version: release.version });
      return { result: "held", reason: `policy is notify-only; ${release.version} is available` };
    }
    if (!request.consented && deps.policy === "confirm") {
      await deps.operation.transition({ phase: "held", outcome: "held", reason: "confirmation-required" });
      await notify("confirm-request", { version: release.version, current });
      return { result: "held", reason: `policy requires confirmation before upgrading to ${release.version}` };
    }
    const refusal = deps.checkCompatibility
      ? await deps.checkCompatibility(current, release.version)
      : null;
    if (refusal !== null) {
      await deps.operation.transition({ phase: "held", outcome: "held", reason: refusal });
      await notify("held", { reason: "incompatible", detail: refusal });
      return { result: "held", reason: `incompatible: ${refusal}` };
    }

    await deps.operation.transition({ phase: "downloading" });
    progress({ stage: "downloading", version: release.version });
    const bytes = await downloadVerified(release, {
      clock: deps.clock,
      resumeDir: path.join(deps.stateDir, "incoming"),
      onProgress: (downloaded, total) =>
        progress({ stage: "downloading", version: release.version, downloaded, total }),
    });
    await deps.operation.transition({ phase: "verifying" });
    progress({ stage: "verifying", version: release.version });
    await deps.operation.transition({ phase: "staging" });
    progress({ stage: "staging", version: release.version });
    const bytesRef = await materializeArtifact(deps.stateDir, bytes);
    if (deps.provenanceJournal) {
      await recordReconcile(
        deps.provenanceJournal,
        request.provenance ?? deps.provenanceIdentity,
        release.version,
      );
    }

    await deps.operation.transition({ phase: "handing-over" });
    progress({ stage: "handing-over", version: release.version });
    let engineOutcome: EngineOutcome;
    try {
      engineOutcome = await deps.engine.upgrade({ version: release.version, bytesRef });
    } catch (error) {
      await deps.operation.transition({
        phase: "recovering",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const finished = await finishUpgradeOutcome(engineOutcome, {
      notify,
      reportStage: progress,
      targetVersion: release.version,
      declaredSurfaces: deps.lifecycleSurfaceCount,
      nowMs: deps.clock.nowMs(),
      evidence: deps.evidence(),
      lifecycle: deps.lifecycle(),
    });
    if (finished.report !== null) await deps.persistConvergenceReport(finished.report);
    switch (finished.outcome.result) {
      case "promoted":
        await deps.operation.transition({ phase: "promoted", outcome: "promoted" });
        break;
      case "rolled-back":
        await deps.operation.transition({ phase: "rolled-back", outcome: "rolled-back", reason: finished.outcome.reason });
        break;
      case "held":
        await deps.operation.transition({ phase: "held", outcome: "held", reason: finished.outcome.reason });
        break;
      case "up-to-date":
        await deps.operation.transition({ phase: "up-to-date", outcome: "up-to-date" });
        break;
    }
    return finished.outcome;
  } finally {
    await lock.release();
  }
}
