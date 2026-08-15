import type {
  Artifact,
  JournalEntry,
  ProcessEvidence,
  Slot,
} from "../../src/domain.ts";

export interface HarnessWorld {
  readonly journal: Array<JournalEntry>;
  stable: Artifact;
  experiment: Artifact | null;
  running: Slot | null;
  evidence: ProcessEvidence | null;
  quiesced: boolean;
  clockMillis: number;
  startCounter: number;
  lockHeld: boolean;
  readonly completedActions: Set<string>;
  readonly sideEffects: Map<string, number>;
  readonly trace: Array<string>;
}

export const makeWorld = (): HarnessWorld => ({
  journal: [],
  stable: { version: "1.0.0", digest: "sha256:stable" },
  experiment: null,
  running: "stable",
  evidence: { version: "1.0.0", startId: "start-1" },
  quiesced: false,
  clockMillis: 1_700_000_000_000,
  startCounter: 1,
  lockHeld: false,
  completedActions: new Set(),
  sideEffects: new Map(),
  trace: [],
});

export const incrementEffect = (world: HarnessWorld, name: string): void => {
  world.sideEffects.set(name, (world.sideEffects.get(name) ?? 0) + 1);
};
