import type { Clock } from "./clock.ts";
import { phaseAtRest, type TxnState } from "./txn/state.ts";
import type { ProvenanceIdentity } from "./upgrader.ts";
import {
  acknowledgeOperation,
  loadOperation,
  persistOperation,
  type OperationDescriptor,
  type OperationOutcome,
  type OperationPhase,
  type OperationRead,
  type OperationRecord,
} from "./operation.ts";

export interface OperationLifecycle {
  begin(
    descriptor: OperationDescriptor | null,
    fromVersion: string,
    targetVersion: string,
    provenance: ProvenanceIdentity | null,
  ): Promise<void>;
  transition(input: {
    phase: OperationPhase;
    outcome?: OperationOutcome | null;
    reason?: string | null;
  }): Promise<void>;
  settleRecovery(): Promise<void>;
  reset(): void;
  read(): Promise<OperationRead>;
  acknowledge(operationId: string): Promise<"acknowledged" | "not-terminal" | "not-found" | "changed">;
}

export function createOperationLifecycle(
  stateDir: string,
  clock: Clock,
  readState: () => Promise<TxnState>,
): OperationLifecycle {
  let record: OperationRecord | null = null;

  const transition: OperationLifecycle["transition"] = async (input) => {
    if (record === null) return;
    record = {
      ...record,
      updatedAtMs: clock.nowMs(),
      phase: input.phase,
      outcome: input.outcome === undefined ? record.outcome : input.outcome,
      reason: input.reason === undefined ? record.reason : input.reason,
    };
    await persistOperation(stateDir, record);
  };

  return {
    async begin(descriptor, fromVersion, targetVersion, provenance) {
      if (descriptor === null) return;
      const existing = await loadOperation(stateDir);
      if (existing.kind === "unreadable") throw new Error(existing.reason);
      if (existing.kind === "observed" && existing.operation.id !== descriptor.id) {
        if (existing.operation.outcome === null) {
          throw new Error(`OPERATION_IN_PROGRESS: ${existing.operation.id}`);
        }
        if (existing.operation.acknowledgedAtMs === null) {
          throw new Error(`OPERATION_RECEIPT_PENDING: ${existing.operation.id}`);
        }
      }
      if (existing.kind === "observed" && existing.operation.id === descriptor.id) {
        record = existing.operation;
        return;
      }
      record = {
        formatVersion: 1,
        id: descriptor.id,
        startedAtMs: descriptor.startedAtMs,
        updatedAtMs: clock.nowMs(),
        fromVersion,
        targetVersion,
        previousStableVersion: fromVersion,
        phase: "checking",
        outcome: null,
        reason: null,
        provenance: descriptor.provenance ?? provenance,
        metadata: { ...descriptor.metadata },
        acknowledgedAtMs: null,
      };
      await persistOperation(stateDir, record);
    },

    transition,

    async settleRecovery() {
      const observed = await loadOperation(stateDir);
      if (observed.kind !== "observed" || observed.operation.outcome !== null) return;
      record = observed.operation;
      const state = await readState();
      if (state.phase === "promoted" && state.stableVersion === record.targetVersion) {
        await transition({ phase: "promoted", outcome: "promoted" });
      } else if (phaseAtRest(state.phase)) {
        await transition({
          phase: "rolled-back",
          outcome: "rolled-back",
          reason: state.rollbackReason ?? `recovery settled at ${state.phase} with stable ${state.stableVersion}`,
        });
      }
    },

    reset() {
      record = null;
    },

    read: () => loadOperation(stateDir),

    acknowledge: (operationId) => acknowledgeOperation(stateDir, operationId, clock.nowMs()),
  };
}
