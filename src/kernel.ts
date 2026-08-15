import { Effect, Schema } from "effect";
import type {
  HostMutation,
  JournalEntry,
  Phase,
  ProcessEvidence,
  UpgradeOutcome,
  UpgradeRequest,
} from "./domain.ts";
import { JournalSchema } from "./domain.ts";
import {
  invalidJournal,
  invariantViolation,
  type KError,
} from "./errors.ts";
import {
  Host,
  Journal,
  KClock,
  ReleaseSource,
  Slots,
  UpgradeLock,
  Verifier,
} from "./services.ts";
import type {
  HostService,
  JournalService,
  ClockService,
  ReleaseSourceService,
  SlotsService,
  UpgradeLockService,
  VerifierService,
} from "./services.ts";

export type UpgradeServices =
  | JournalService
  | ClockService
  | SlotsService
  | ReleaseSourceService
  | HostService
  | VerifierService
  | UpgradeLockService;

export type RecoveryServices =
  | JournalService
  | ClockService
  | SlotsService
  | HostService
  | VerifierService
  | UpgradeLockService;

interface JournalWriter {
  readonly append: (
    phase: Phase,
    details?: {
      readonly targetVersion?: string;
      readonly priorStartId?: string;
      readonly reason?: string;
    },
  ) => Effect.Effect<void, KError>;
}

const decodeJournal = (input: unknown) =>
  Schema.decodeUnknown(JournalSchema)(input).pipe(
    Effect.mapError((error) => invalidJournal(String(error))),
    Effect.flatMap((entries) => {
      let priorSequence = 0;
      for (const entry of entries) {
        if (
          !Number.isSafeInteger(entry.sequence) ||
          entry.sequence <= priorSequence ||
          !Number.isFinite(entry.at) ||
          entry.at < 0 ||
          entry.operationId.length === 0
        ) {
          return Effect.fail(
            invalidJournal(
              "journal sequence, timestamp, or operation id is invalid",
            ),
          );
        }
        priorSequence = entry.sequence;
      }
      return Effect.succeed(entries);
    }),
  );

const readJournal = Effect.gen(function* () {
  const journal = yield* Journal;
  return yield* journal.read.pipe(Effect.flatMap(decodeJournal));
});

const writerFor = (operationId: string) =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const clock = yield* KClock;
    const entries = yield* journal.read.pipe(Effect.flatMap(decodeJournal));
    let sequence = entries.at(-1)?.sequence ?? 0;

    const append: JournalWriter["append"] = (phase, details = {}) =>
      Effect.gen(function* () {
        const at = yield* clock.now;
        sequence += 1;
        const entry: JournalEntry = {
          format: 2,
          sequence,
          operationId,
          at,
          phase,
          ...(details.targetVersion === undefined
            ? {}
            : { targetVersion: details.targetVersion }),
          ...(details.priorStartId === undefined
            ? {}
            : { priorStartId: details.priorStartId }),
          ...(details.reason === undefined ? {} : { reason: details.reason }),
        };
        // A journal commit is the only uninterruptible region. Host calls remain
        // interruptible and are never hidden inside this region.
        yield* Effect.uninterruptible(journal.append(entry));
      });

    return { append } satisfies JournalWriter;
  });

const mutation = (operationId: string, step: string): HostMutation => ({
  operationId,
  actionId: `${operationId}:${step}`,
});

const restoreStable = (
  operationId: string,
  writer: JournalWriter,
  targetVersion: string,
  reason: string,
) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const slots = yield* Slots;
    yield* writer.append("rolled_back", { targetVersion, reason });
    yield* host.stop("experiment", mutation(operationId, "rollback-stop"));
    yield* host.start("stable", mutation(operationId, "rollback-start"));
    yield* host.resume(mutation(operationId, "rollback-resume"));
    yield* slots.clearExperiment;
    return {
      _tag: "RolledBack",
      operationId,
      version: targetVersion,
      reason,
    } satisfies UpgradeOutcome;
  });

const finishCommit = (
  operationId: string,
  writer: JournalWriter,
  targetVersion: string,
) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const slots = yield* Slots;
    yield* writer.append("committed", { targetVersion });
    yield* slots.promote;
    yield* host.resume(mutation(operationId, "commit-resume"));
  });

const executeUpgrade = (request: UpgradeRequest) =>
  Effect.gen(function* () {
    if (request.operationId.length === 0 || request.targetVersion.length === 0) {
      return yield* Effect.fail(
        invariantViolation("operationId and targetVersion must be non-empty"),
      );
    }

    const existing = (yield* readJournal).filter(
      (entry) => entry.operationId === request.operationId,
    );
    if (existing.length > 0) {
      return yield* Effect.fail(
        invariantViolation(
          `operation ${request.operationId} already exists; recover it instead`,
        ),
      );
    }

    const slots = yield* Slots;
    const source = yield* ReleaseSource;
    const host = yield* Host;
    const verifier = yield* Verifier;
    const stable = yield* slots.stable;
    if (stable.version === request.targetVersion) {
      return {
        _tag: "UpToDate",
        operationId: request.operationId,
        version: stable.version,
      } satisfies UpgradeOutcome;
    }

    const target = yield* source.resolve(request.targetVersion);
    const writer = yield* writerFor(request.operationId);
    yield* writer.append("staged", { targetVersion: target.version });
    yield* slots.stage(target);

    const attempt = Effect.gen(function* () {
      const prior = yield* host.probe;
      yield* writer.append("handover", {
        targetVersion: target.version,
        priorStartId: prior.startId,
      });
      yield* host.quiesce(mutation(request.operationId, "handover-quiesce"));
      yield* host.stop("stable", mutation(request.operationId, "handover-stop"));
      yield* host.start(
        "experiment",
        mutation(request.operationId, "handover-start"),
      );
      yield* writer.append("experiment_running", {
        targetVersion: target.version,
        priorStartId: prior.startId,
      });
      const evidence = yield* host.probe;
      yield* writer.append("verifying", {
        targetVersion: target.version,
        priorStartId: prior.startId,
      });
      yield* verifier.verify(evidence, target);
      yield* finishCommit(request.operationId, writer, target.version);
      return {
        _tag: "Promoted",
        operationId: request.operationId,
        version: target.version,
      } satisfies UpgradeOutcome;
    });

    return yield* attempt.pipe(
      Effect.catchTag("HostFailure", (error) =>
        restoreStable(
          request.operationId,
          writer,
          target.version,
          `${error.step}: ${error.message}`,
        ),
      ),
      Effect.catchTag("PredicateRefused", (error) =>
        restoreStable(
          request.operationId,
          writer,
          target.version,
          `${error.predicate}: ${error.message}`,
        ),
      ),
    );
  });

const recoverOperation = (operationId: string) =>
  Effect.gen(function* () {
    if (operationId.length === 0) {
      return yield* Effect.fail(
        invariantViolation("operationId must be non-empty"),
      );
    }

    const entries = (yield* readJournal).filter(
      (entry) => entry.operationId === operationId,
    );
    const last = entries.at(-1);
    if (last === undefined) return;
    if (last.targetVersion === undefined) {
      return yield* Effect.fail(
        invalidJournal(`operation ${operationId} has no targetVersion`),
      );
    }

    const writer = yield* writerFor(operationId);
    const slots = yield* Slots;
    const host = yield* Host;
    const verifier = yield* Verifier;

    if (last.phase === "committed") {
      yield* slots.promote;
      yield* host.resume(mutation(operationId, "commit-resume"));
      return;
    }

    if (last.phase === "rolled_back") {
      yield* host.stop("experiment", mutation(operationId, "rollback-stop"));
      yield* host.start("stable", mutation(operationId, "rollback-start"));
      yield* host.resume(mutation(operationId, "rollback-resume"));
      yield* slots.clearExperiment;
      return;
    }

    if (last.phase === "staged") {
      yield* writer.append("rolled_back", {
        targetVersion: last.targetVersion,
        reason: "recovered before host handover",
      });
      yield* slots.clearExperiment;
      return;
    }

    const target = yield* slots.experiment;
    if (target === null || target.version !== last.targetVersion) {
      return yield* Effect.fail(
        invariantViolation("in-flight journal does not match experiment slot"),
      );
    }

    const decide = (evidence: ProcessEvidence) => {
      const isFreshTarget =
        evidence.version === target.version &&
        (last.priorStartId === undefined ||
          evidence.startId !== last.priorStartId);
      if (!isFreshTarget) {
        return restoreStable(
          operationId,
          writer,
          target.version,
          "recovery did not observe a fresh target process",
        ).pipe(Effect.asVoid);
      }
      return verifier.verify(evidence, target).pipe(
        Effect.flatMap(() =>
          finishCommit(operationId, writer, target.version),
        ),
        Effect.catchTag("PredicateRefused", (error) =>
          restoreStable(
            operationId,
            writer,
            target.version,
            `${error.predicate}: ${error.message}`,
          ).pipe(Effect.asVoid),
        ),
      );
    };

    yield* host.probe.pipe(
      Effect.flatMap(decide),
      Effect.catchTag("HostFailure", (error) =>
        restoreStable(
          operationId,
          writer,
          target.version,
          `${error.step}: ${error.message}`,
        ).pipe(Effect.asVoid),
      ),
    );
  });

const withUpgradeLock = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lock = yield* UpgradeLock;
    return yield* Effect.acquireUseRelease(
      lock.acquire,
      () => program,
      (lease) => lease.release,
    );
  });

export const upgradeEffect = (
  request: UpgradeRequest,
): Effect.Effect<UpgradeOutcome, KError, UpgradeServices> =>
  withUpgradeLock(executeUpgrade(request));

export const recoverEffect = (
  operationId: string,
): Effect.Effect<void, KError, RecoveryServices> =>
  withUpgradeLock(recoverOperation(operationId));
