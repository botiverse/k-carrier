// Public API of @botiverse/k-carrier.
//
// This barrel is the single supported entry point for the core framework;
// deep imports into ./core/src/** are internal and not part of the public API.

// The upgrader factory and its configuration.
export * from "./createUpgrader.ts";

// Core types: Upgrader, UpgraderConfig, UpgradeOutcome, ProvenanceIdentity,
// NotificationEvent.
export * from "./upgrader.ts";

// The host boundary an adopter implements: HostAdapter, Slot, ProcessEvidence.
export * from "./lifecycle/hostAdapter.ts";

// The built-in invariants and their types (WorldSnapshot, Invariant, ...).
export * from "./invariants.ts";
