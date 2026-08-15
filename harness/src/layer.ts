import { Effect, Layer } from "effect";
import type {
  Artifact,
  HostMutation,
  JournalEntry,
  Slot,
} from "../../src/domain.ts";
import type {
  HostCallError,
  HostFailure,
  HostOutcomeUnknown,
  JournalFailure,
  LockUnavailable,
  PredicateRefused,
  SlotFailure,
  SourceFailure,
} from "../../src/errors.ts";
import {
  Host,
  Journal,
  KClock,
  ReleaseSource,
  Slots,
  UpgradeLock,
  Verifier,
} from "../../src/services.ts";
import { incrementEffect, type HarnessWorld } from "./model.ts";

export interface HarnessPlan {
  readonly crashAfter?: string;
  readonly unknownAfter?: string;
  readonly refuseVerification?: boolean;
}

export class SimulatedProcessCrash extends Error {
  readonly boundary: string;

  constructor(boundary: string) {
    super(`simulated process crash after ${boundary}`);
    this.name = "SimulatedProcessCrash";
    this.boundary = boundary;
  }
}

interface BoundaryController {
  readonly after: (name: string) => Effect.Effect<string>;
  readonly isUnknown: (label: string) => boolean;
}

const makeBoundaryController = (
  world: HarnessWorld,
  plan: HarnessPlan,
): BoundaryController => {
  const counts = new Map<string, number>();
  return {
    after: (name) =>
      Effect.sync(() => {
        const count = (counts.get(name) ?? 0) + 1;
        counts.set(name, count);
        const label = `${name}#${count}`;
        world.trace.push(label);
        if (plan.crashAfter === label) {
          throw new SimulatedProcessCrash(label);
        }
        return label;
      }),
    isUnknown: (label) => plan.unknownAfter === label,
  };
};

const slotFailure = (
  operation: SlotFailure["operation"],
  message: string,
): SlotFailure => ({ _tag: "SlotFailure", operation, message });

const hostFailure = (step: string, message: string): HostFailure => ({
  _tag: "HostFailure",
  step,
  message,
});

const actionUnknown = (
  step: string,
  mutation: HostMutation,
): HostOutcomeUnknown => ({
  _tag: "HostOutcomeUnknown",
  step,
  actionId: mutation.actionId,
  message: "deterministic harness lost the response after the side effect",
});

export const makeHarnessLayer = (
  world: HarnessWorld,
  plan: HarnessPlan = {},
) => {
  const controller = makeBoundaryController(world, plan);

  const journalLayer = Layer.succeed(Journal, {
    read: Effect.sync(() => world.journal.map((entry) => ({ ...entry }))).pipe(
      Effect.tap(() => controller.after("journal:read")),
    ),
    append: (entry: JournalEntry) =>
      Effect.sync(() => {
        world.journal.push({ ...entry });
        incrementEffect(world, `journal:${entry.phase}`);
      }).pipe(
        Effect.zipRight(controller.after(`journal:${entry.phase}`)),
        Effect.asVoid,
      ) as Effect.Effect<void, JournalFailure>,
  });

  const clockLayer = Layer.succeed(KClock, {
    now: Effect.sync(() => {
      world.clockMillis += 1;
      return world.clockMillis;
    }),
  });

  const slotsLayer = Layer.succeed(Slots, {
    stable: Effect.sync(() => ({ ...world.stable })).pipe(
      Effect.tap(() => controller.after("slots:stable")),
    ),
    experiment: Effect.sync(() =>
      world.experiment === null ? null : { ...world.experiment },
    ).pipe(Effect.tap(() => controller.after("slots:experiment"))),
    stage: (artifact: Artifact) =>
      Effect.sync(() => {
        world.experiment = { ...artifact };
        incrementEffect(world, "slots:stage");
      }).pipe(
        Effect.zipRight(controller.after("slots:stage")),
        Effect.asVoid,
      ) as Effect.Effect<void, SlotFailure>,
    promote: Effect.gen(function* () {
      if (world.experiment === null) {
        if (world.running === "stable") return;
        return yield* Effect.fail(
          slotFailure("promote", "no experiment artifact is available"),
        );
      }
      world.stable = { ...world.experiment };
      world.experiment = null;
      if (world.running === "experiment") world.running = "stable";
      incrementEffect(world, "slots:promote");
      yield* controller.after("slots:promote");
    }),
    clearExperiment: Effect.sync(() => {
      world.experiment = null;
      incrementEffect(world, "slots:clear");
    }).pipe(
      Effect.zipRight(controller.after("slots:clear")),
      Effect.asVoid,
    ) as Effect.Effect<void, SlotFailure>,
  });

  const sourceLayer = Layer.succeed(ReleaseSource, {
    resolve: (targetVersion: string) =>
      Effect.succeed({
        version: targetVersion,
        digest: `sha256:${targetVersion}`,
      }).pipe(
        Effect.tap(() => controller.after("source:resolve")),
      ) as Effect.Effect<Artifact, SourceFailure>,
  });

  const mutate = (
    name: string,
    mutation: HostMutation,
    sideEffect: () => void,
  ): Effect.Effect<void, HostCallError> =>
    Effect.gen(function* () {
      if (world.completedActions.has(mutation.actionId)) return;
      sideEffect();
      world.completedActions.add(mutation.actionId);
      incrementEffect(world, name);
      const label = yield* controller.after(name);
      if (controller.isUnknown(label)) {
        return yield* Effect.fail(actionUnknown(name, mutation));
      }
    });

  const hostLayer = Layer.succeed(Host, {
    quiesce: (entry) =>
      mutate("host:quiesce", entry, () => {
        world.quiesced = true;
      }),
    stop: (slot: Slot, entry: HostMutation) =>
      mutate(`host:stop:${slot}`, entry, () => {
        if (world.running === slot) {
          world.running = null;
          world.evidence = null;
        }
      }),
    start: (slot: Slot, entry: HostMutation) =>
      Effect.gen(function* () {
        if (slot === "experiment" && world.experiment === null) {
          return yield* Effect.fail(
            hostFailure("start:experiment", "experiment slot is empty"),
          );
        }
        yield* mutate(`host:start:${slot}`, entry, () => {
          const artifact =
            slot === "stable" ? world.stable : world.experiment;
          if (artifact === null) return;
          world.startCounter += 1;
          world.running = slot;
          world.evidence = {
            version: artifact.version,
            startId: `start-${world.startCounter}`,
          };
        });
      }),
    resume: (entry) =>
      mutate("host:resume", entry, () => {
        world.quiesced = false;
      }),
    probe: Effect.gen(function* () {
      if (world.evidence === null) {
        return yield* Effect.fail(
          hostFailure("probe", "no managed process is running"),
        );
      }
      const evidence = { ...world.evidence };
      yield* controller.after("host:probe");
      return evidence;
    }),
  });

  const verifierLayer = Layer.succeed(Verifier, {
    verify: (evidence, target) =>
      Effect.gen(function* () {
        incrementEffect(world, "verify");
        yield* controller.after("verify");
        if (
          plan.refuseVerification === true ||
          evidence.version !== target.version
        ) {
          return yield* Effect.fail({
            _tag: "PredicateRefused",
            predicate: "version-readback",
            message: "observed process does not satisfy the target",
          } satisfies PredicateRefused);
        }
      }),
  });

  const lockLayer = Layer.succeed(UpgradeLock, {
    acquire: Effect.gen(function* () {
      if (world.lockHeld) {
        return yield* Effect.fail({
          _tag: "LockUnavailable",
          message: "upgrade lock is already held",
        } satisfies LockUnavailable);
      }
      world.lockHeld = true;
      yield* controller.after("lock:acquire");
      return {
        release: Effect.sync(() => {
          world.lockHeld = false;
        }),
      };
    }),
  });

  return Layer.mergeAll(
    journalLayer,
    slotsLayer,
    sourceLayer,
    hostLayer,
    verifierLayer,
    lockLayer,
    clockLayer,
  );
};
