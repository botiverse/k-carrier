import { Schema } from "effect";

export const PhaseSchema = Schema.Literal(
  "staged",
  "handover",
  "experiment_running",
  "verifying",
  "committed",
  "rolled_back",
);

export type Phase = typeof PhaseSchema.Type;

export const SlotSchema = Schema.Literal("stable", "experiment");
export type Slot = typeof SlotSchema.Type;

export const ArtifactSchema = Schema.Struct({
  version: Schema.String,
  digest: Schema.String,
});
export type Artifact = typeof ArtifactSchema.Type;

export const ProcessEvidenceSchema = Schema.Struct({
  version: Schema.String,
  startId: Schema.String,
});
export type ProcessEvidence = typeof ProcessEvidenceSchema.Type;

export const JournalEntrySchema = Schema.Struct({
  format: Schema.Literal(2),
  sequence: Schema.Number,
  operationId: Schema.String,
  at: Schema.Number,
  phase: PhaseSchema,
  targetVersion: Schema.optional(Schema.String),
  priorStartId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type JournalEntry = typeof JournalEntrySchema.Type;

export const JournalSchema = Schema.Array(JournalEntrySchema);

export interface UpgradeRequest {
  readonly operationId: string;
  readonly targetVersion: string;
}

export interface PromotedOutcome {
  readonly _tag: "Promoted";
  readonly operationId: string;
  readonly version: string;
}

export interface RolledBackOutcome {
  readonly _tag: "RolledBack";
  readonly operationId: string;
  readonly version: string;
  readonly reason: string;
}

export interface UpToDateOutcome {
  readonly _tag: "UpToDate";
  readonly operationId: string;
  readonly version: string;
}

export type UpgradeOutcome =
  | PromotedOutcome
  | RolledBackOutcome
  | UpToDateOutcome;

export interface HostMutation {
  readonly operationId: string;
  readonly actionId: string;
}
