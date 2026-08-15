import { Effect, Layer, ManagedRuntime } from "effect";
import type {
  Artifact,
  HostMutation,
  JournalEntry,
  ProcessEvidence,
  Slot,
  UpgradeOutcome,
  UpgradeRequest,
} from "./domain.ts";
import type {
  HostCallError,
  HostFailure,
  HostOutcomeUnknown,
  JournalFailure,
  LockUnavailable,
  PredicateRefused,
  SlotFailure,
  SourceFailure,
} from "./errors.ts";
import { recoverEffect, upgradeEffect } from "./kernel.ts";
import {
  Host,
  Journal,
  KClock,
  ReleaseSource,
  Slots,
  UpgradeLock,
  Verifier,
} from "./services.ts";

export type HostMutationResult = "done" | "unknown";

export type HostProbeResult =
  | { readonly _tag: "Observed"; readonly evidence: ProcessEvidence }
  | { readonly _tag: "Unknown" };

export interface PromiseKernelAdapter {
  readonly clock: {
    readonly now: () => Promise<number>;
  };
  readonly journal: {
    readonly read: () => Promise<unknown>;
    readonly appendAndSync: (entry: JournalEntry) => Promise<void>;
  };
  readonly slots: {
    readonly stable: () => Promise<Artifact>;
    readonly experiment: () => Promise<Artifact | null>;
    readonly stage: (artifact: Artifact) => Promise<void>;
    readonly promote: () => Promise<void>;
    readonly clearExperiment: () => Promise<void>;
  };
  readonly source: {
    readonly resolve: (targetVersion: string) => Promise<Artifact>;
  };
  readonly host: {
    readonly quiesce: (
      mutation: HostMutation,
    ) => Promise<HostMutationResult>;
    readonly stop: (
      slot: Slot,
      mutation: HostMutation,
    ) => Promise<HostMutationResult>;
    readonly start: (
      slot: Slot,
      mutation: HostMutation,
    ) => Promise<HostMutationResult>;
    readonly resume: (
      mutation: HostMutation,
    ) => Promise<HostMutationResult>;
    readonly probe: () => Promise<HostProbeResult>;
  };
  readonly verify: (
    evidence: ProcessEvidence,
    target: Artifact,
  ) => Promise<boolean>;
  readonly lock: {
    readonly acquire: () => Promise<() => Promise<void>>;
  };
}

export interface PromiseKernel {
  readonly upgrade: (request: UpgradeRequest) => Promise<UpgradeOutcome>;
  readonly recover: (operationId: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hostFailure = (step: string, error: unknown): HostFailure => ({
  _tag: "HostFailure",
  step,
  message: messageOf(error),
});

const hostMutation = (
  step: string,
  mutation: HostMutation,
  run: () => Promise<HostMutationResult>,
): Effect.Effect<void, HostCallError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => hostFailure(step, error),
  }).pipe(
    Effect.flatMap((result) =>
      result === "done"
        ? Effect.void
        : Effect.fail({
            _tag: "HostOutcomeUnknown",
            step,
            actionId: mutation.actionId,
            message: "adapter could not establish the mutation outcome",
          } satisfies HostOutcomeUnknown),
    ),
  );

export const createPromiseKernel = (
  adapter: PromiseKernelAdapter,
): PromiseKernel => {
  const journalLayer = Layer.succeed(Journal, {
    read: Effect.tryPromise({
      try: adapter.journal.read,
      catch: (error): JournalFailure => ({
        _tag: "JournalFailure",
        operation: "read",
        message: messageOf(error),
      }),
    }),
    append: (entry) =>
      Effect.tryPromise({
        try: () => adapter.journal.appendAndSync(entry),
        catch: (error): JournalFailure => ({
          _tag: "JournalFailure",
          operation: "append",
          message: messageOf(error),
        }),
      }),
  });

  const clockLayer = Layer.succeed(KClock, {
    now: Effect.promise(adapter.clock.now),
  });

  const slotsLayer = Layer.succeed(Slots, {
    stable: Effect.tryPromise({
      try: adapter.slots.stable,
      catch: (error): SlotFailure => ({
        _tag: "SlotFailure",
        operation: "read",
        message: messageOf(error),
      }),
    }),
    experiment: Effect.tryPromise({
      try: adapter.slots.experiment,
      catch: (error): SlotFailure => ({
        _tag: "SlotFailure",
        operation: "read",
        message: messageOf(error),
      }),
    }),
    stage: (artifact) =>
      Effect.tryPromise({
        try: () => adapter.slots.stage(artifact),
        catch: (error): SlotFailure => ({
          _tag: "SlotFailure",
          operation: "stage",
          message: messageOf(error),
        }),
      }),
    promote: Effect.tryPromise({
      try: adapter.slots.promote,
      catch: (error): SlotFailure => ({
        _tag: "SlotFailure",
        operation: "promote",
        message: messageOf(error),
      }),
    }),
    clearExperiment: Effect.tryPromise({
      try: adapter.slots.clearExperiment,
      catch: (error): SlotFailure => ({
        _tag: "SlotFailure",
        operation: "clear",
        message: messageOf(error),
      }),
    }),
  });

  const sourceLayer = Layer.succeed(ReleaseSource, {
    resolve: (targetVersion) =>
      Effect.tryPromise({
        try: () => adapter.source.resolve(targetVersion),
        catch: (error): SourceFailure => ({
          _tag: "SourceFailure",
          targetVersion,
          message: messageOf(error),
        }),
      }),
  });

  const hostLayer = Layer.succeed(Host, {
    quiesce: (entry) =>
      hostMutation("quiesce", entry, () => adapter.host.quiesce(entry)),
    stop: (slot, entry) =>
      hostMutation(`stop:${slot}`, entry, () =>
        adapter.host.stop(slot, entry),
      ),
    start: (slot, entry) =>
      hostMutation(`start:${slot}`, entry, () =>
        adapter.host.start(slot, entry),
      ),
    resume: (entry) =>
      hostMutation("resume", entry, () => adapter.host.resume(entry)),
    probe: Effect.tryPromise({
      try: adapter.host.probe,
      catch: (error) => hostFailure("probe", error),
    }).pipe(
      Effect.flatMap((result) =>
        result._tag === "Observed"
          ? Effect.succeed(result.evidence)
          : Effect.fail({
              _tag: "HostOutcomeUnknown",
              step: "probe",
              actionId: "probe",
              message: "adapter could not establish the observed process",
            } satisfies HostOutcomeUnknown),
      ),
    ),
  });

  const verifierLayer = Layer.succeed(Verifier, {
    verify: (evidence, target) =>
      Effect.tryPromise({
        try: () => adapter.verify(evidence, target),
        catch: (error): PredicateRefused => ({
          _tag: "PredicateRefused",
          predicate: "adapter",
          message: messageOf(error),
        }),
      }).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.fail({
                _tag: "PredicateRefused",
                predicate: "adapter",
                message: "verification returned false",
              } satisfies PredicateRefused),
        ),
      ),
  });

  const lockLayer = Layer.succeed(UpgradeLock, {
    acquire: Effect.tryPromise({
      try: adapter.lock.acquire,
      catch: (error): LockUnavailable => ({
        _tag: "LockUnavailable",
        message: messageOf(error),
      }),
    }).pipe(
      Effect.map((release) => ({
        release: Effect.promise(release),
      })),
    ),
  });

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      journalLayer,
      clockLayer,
      slotsLayer,
      sourceLayer,
      hostLayer,
      verifierLayer,
      lockLayer,
    ),
  );

  return {
    upgrade: (request) => runtime.runPromise(upgradeEffect(request)),
    recover: (operationId) => runtime.runPromise(recoverEffect(operationId)),
    close: runtime.dispose,
  };
};
