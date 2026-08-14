// Public API of @botiverse/k-carrier.
//
// This barrel is the single supported entry point for the core framework;
// deep imports into ./core/src/** are internal and not part of the public API.

// The upgrader factory and its configuration.
export * from "./createUpgrader.ts";

// One-time adoption of an already-running trusted binary into K's stable
// slot, plus the K-owned slot resolver host adapters use to launch it.
export * from "./bootstrap.ts";

// Core types: Upgrader, UpgraderConfig, UpgradeOutcome, ProvenanceIdentity,
// NotificationEvent.
export * from "./upgrader.ts";
export * from "./operation.ts";

// The release-source boundary applications implement and the durable
// provenance journal they wire into createUpgrader.
export * from "./artifact/source.ts";
export * from "./provenance/journal.ts";

// The host boundary an adopter implements: HostAdapter, Slot, ProcessEvidence.
export * from "./lifecycle/hostAdapter.ts";

// The built-in invariants and their types (WorldSnapshot, Invariant, ...).
export * from "./invariants.ts";
