export interface JournalFailure {
  readonly _tag: "JournalFailure";
  readonly operation: "read" | "append";
  readonly message: string;
}

export interface InvalidJournal {
  readonly _tag: "InvalidJournal";
  readonly message: string;
}

export interface SlotFailure {
  readonly _tag: "SlotFailure";
  readonly operation: "read" | "stage" | "promote" | "clear";
  readonly message: string;
}

export interface SourceFailure {
  readonly _tag: "SourceFailure";
  readonly targetVersion: string;
  readonly message: string;
}

export interface HostFailure {
  readonly _tag: "HostFailure";
  readonly step: string;
  readonly message: string;
}

export interface HostOutcomeUnknown {
  readonly _tag: "HostOutcomeUnknown";
  readonly step: string;
  readonly actionId: string;
  readonly message: string;
}

export interface PredicateRefused {
  readonly _tag: "PredicateRefused";
  readonly predicate: string;
  readonly message: string;
}

export interface LockUnavailable {
  readonly _tag: "LockUnavailable";
  readonly message: string;
}

export interface InvariantViolation {
  readonly _tag: "InvariantViolation";
  readonly message: string;
}

export type HostCallError = HostFailure | HostOutcomeUnknown;

export type KError =
  | JournalFailure
  | InvalidJournal
  | SlotFailure
  | SourceFailure
  | HostFailure
  | HostOutcomeUnknown
  | PredicateRefused
  | LockUnavailable
  | InvariantViolation;

export const invalidJournal = (message: string): InvalidJournal => ({
  _tag: "InvalidJournal",
  message,
});

export const invariantViolation = (message: string): InvariantViolation => ({
  _tag: "InvariantViolation",
  message,
});
