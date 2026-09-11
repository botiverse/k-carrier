// Public API of @botiverse/k-carrier.
//
// This barrel is the single supported entry point for the core framework;
// deep imports into ./core/src/** are internal and not part of the public API.

// Compose the transaction engine inside a runner; no forwarding factory.
export { createRunner } from "./createRunner.ts";
export type { RunnerOptions } from "./createRunner.ts";

// One-time adoption of an already-running trusted binary into K's stable
// slot, plus the K-owned slot resolver host adapters use to launch it.
export * from "./bootstrap.ts";

// Core types: Upgrader, UpgraderConfig, UpgradeOutcome, ProvenanceIdentity,
// NotificationEvent.
export * from "./upgrader.ts";
export * from "./operation.ts";
export * from "./quarantine.ts";

// The release-source boundary applications implement and the durable
// provenance journal they wire into createRunner.
export * from "./artifact/source.ts";
export * from "./artifact/transferPolicy.ts";
// The verified downloader, so an installer's own paths (fresh install,
// sidecars, repair) fetch bytes with the same budgets and checks as K.
export { downloadVerified } from "./artifact/download.ts";
export * from "./provenance/journal.ts";

// The host boundary an adopter implements: HostAdapter, Slot, ProcessEvidence.
export * from "./lifecycle/hostAdapter.ts";

// The built-in invariants and their types (WorldSnapshot, Invariant, ...).
export * from "./invariants.ts";
export * from "./protocol/runner.ts";
export * from "./runner/execute.ts";
export * from "./runner/cli.ts";
export * from "./launcher/launch.ts";
export * from "./lifecycle/commandHost.ts";

export { HostCallTimeout, HostCallUncertain } from "./txn/hostCallBudget.ts";
