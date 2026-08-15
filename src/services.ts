import { Context, Effect } from "effect";
import type {
  Artifact,
  HostMutation,
  JournalEntry,
  ProcessEvidence,
  Slot,
} from "./domain.ts";
import type {
  HostCallError,
  JournalFailure,
  LockUnavailable,
  PredicateRefused,
  SlotFailure,
  SourceFailure,
} from "./errors.ts";

export interface JournalService {
  readonly read: Effect.Effect<unknown, JournalFailure>;
  /** Resolves only after the entry is durably synced. */
  readonly append: (
    entry: JournalEntry,
  ) => Effect.Effect<void, JournalFailure>;
}

export const Journal = Context.GenericTag<JournalService>(
  "@botiverse/k-v2/Journal",
);

export interface ClockService {
  readonly now: Effect.Effect<number>;
}

export const KClock = Context.GenericTag<ClockService>(
  "@botiverse/k-v2/Clock",
);

export interface SlotsService {
  readonly stable: Effect.Effect<Artifact, SlotFailure>;
  readonly experiment: Effect.Effect<Artifact | null, SlotFailure>;
  readonly stage: (artifact: Artifact) => Effect.Effect<void, SlotFailure>;
  readonly promote: Effect.Effect<void, SlotFailure>;
  readonly clearExperiment: Effect.Effect<void, SlotFailure>;
}

export const Slots = Context.GenericTag<SlotsService>(
  "@botiverse/k-v2/Slots",
);

export interface ReleaseSourceService {
  readonly resolve: (
    targetVersion: string,
  ) => Effect.Effect<Artifact, SourceFailure>;
}

export const ReleaseSource = Context.GenericTag<ReleaseSourceService>(
  "@botiverse/k-v2/ReleaseSource",
);

/**
 * A repeated actionId must be deduplicated by the adapter. When an outcome is
 * unknown, K stops the turn; a later recovery may safely reissue that same id.
 */
export interface HostService {
  readonly quiesce: (
    mutation: HostMutation,
  ) => Effect.Effect<void, HostCallError>;
  readonly stop: (
    slot: Slot,
    mutation: HostMutation,
  ) => Effect.Effect<void, HostCallError>;
  readonly start: (
    slot: Slot,
    mutation: HostMutation,
  ) => Effect.Effect<void, HostCallError>;
  readonly resume: (
    mutation: HostMutation,
  ) => Effect.Effect<void, HostCallError>;
  readonly probe: Effect.Effect<ProcessEvidence, HostCallError>;
}

export const Host = Context.GenericTag<HostService>("@botiverse/k-v2/Host");

export interface VerifierService {
  readonly verify: (
    evidence: ProcessEvidence,
    target: Artifact,
  ) => Effect.Effect<void, PredicateRefused>;
}

export const Verifier = Context.GenericTag<VerifierService>(
  "@botiverse/k-v2/Verifier",
);

export interface LockLease {
  readonly release: Effect.Effect<void>;
}

export interface UpgradeLockService {
  readonly acquire: Effect.Effect<LockLease, LockUnavailable>;
}

export const UpgradeLock = Context.GenericTag<UpgradeLockService>(
  "@botiverse/k-v2/UpgradeLock",
);

export type KernelServices =
  | JournalService
  | ClockService
  | SlotsService
  | ReleaseSourceService
  | HostService
  | VerifierService
  | UpgradeLockService;
