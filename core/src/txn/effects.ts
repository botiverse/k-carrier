/**
 * Effects — the txn engine's ONLY doorway to the world (sim-first
 * constraint, harness-design §1.45).
 *
 * The engine is a pure state machine: no direct IO, time, or randomness.
 * Everything durable goes through these interfaces. Production wires them
 * to the real filesystem/platform adapters; the simulator wires them to an
 * in-memory disk with seeded fault injection. This is a product-grade
 * abstraction (platform adapters differ in fsync/swap semantics anyway),
 * not a test seam.
 *
 * Durability contract: appendAndSync resolves only after the entry is
 * durable (fsync'd). The engine writes intent BEFORE acting (WAL); recovery
 * trusts the journal, never directory listings or guesses.
 */
import type { JournalEntry } from "./state.ts";
import type { Slot } from "../lifecycle/hostAdapter.ts";

export interface JournalStore {
  /** Append one entry durably. Resolves only after fsync. */
  appendAndSync(entry: JournalEntry): Promise<void>;
  /** All entries in append order (crash-truncated tails already dropped). */
  readAll(): Promise<JournalEntry[]>;
}

export interface SlotStore {
  /** Populate the experiment slot with a verified artifact (atomic: visible fully or not at all). */
  stageExperiment(artifact: { version: string; bytesRef: string }): Promise<void>;
  /** Which version each slot holds; null = empty. */
  slotVersions(): Promise<Record<Slot, string | null>>;
  /** experiment -> stable, old stable dropped. Atomic. */
  promoteExperiment(): Promise<void>;
  /** Drop the experiment slot. Atomic, idempotent. */
  clearExperiment(): Promise<void>;
}

export interface TxnEffects {
  journal: JournalStore;
  slots: SlotStore;
}
