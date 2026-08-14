/**
 * Provenance journal (M6, L5) — WHO reconciled this machine, forward-only.
 *
 * Every reconcile that reaches the upgrade transaction appends an entry
 * {who, carrier, when, version} WRITE-AHEAD of the action, mirroring the
 * txn journal's intent-before-action discipline. A machine that never had
 * the machinery is GENESIS — permanently NOT_OBSERVED and mechanically
 * distinct from "observed with zero reconciles": no-data is not no-problem.
 *
 * Forward-only invariants (each is a harness tooth):
 *  - appends only ever add a line; a seq at or below the last one is a
 *    typed refusal (PROVENANCE_SEQ_REWRITE) — provenance is not rewritable
 *  - a torn final line (crash mid-append) is dropped; earlier lines stand;
 *    a parse failure in a MIDDLE line is corruption: the history is
 *    UNREADABLE, never a short one — appending on it is refused, so one bad
 *    line can never re-open the seq (the rewrite-under-a-truncated-view
 *    attack)
 *  - only ENOENT is genesis: an unreadable journal (EACCES/EISDIR/EIO,
 *    corruption) is a THIRD state, and aggregation must never fold it into
 *    "recorded" OR into "not observed"
 *  - `version` (the artifact version the reconcile drove) is recorded —
 *    K removed the channel concept; the record is who/carrier/version
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { systemClock, type Clock } from "../clock.ts";

const PROVENANCE_FILE = "provenance.jsonl";

export interface ProvenanceEntry {
  /** Monotonic, file order = history order. */
  seq: number;
  /** The driving identity (server/operator) of this reconcile. */
  who: string;
  /** The carrier channel the command travelled on. */
  carrier: string;
  /** Clock-provided timestamp; core never touches Date.now directly. */
  when: number;
  /** The artifact version this reconcile drove (channel is gone from K). */
  version: string;
}

/**
 * Three states, and the distinction is the whole point:
 *  - genesis: no journal file — the machine never had the machinery. The
 *    value is NOT_OBSERVED, not "zero reconciles".
 *  - observed: the machinery exists; entries may be zero (reconciled never).
 *  - unreadable: the journal exists but cannot be read (EACCES/EISDIR/EIO)
 *    or is corrupt (middle-line parse failure). This is NOT genesis — "I
 *    cannot see the data" and "there is no data" are different buckets.
 */
export type ProvenanceRead =
  | { kind: "genesis" }
  | { kind: "observed"; entries: ProvenanceEntry[] }
  | { kind: "unreadable"; reason: string };

export type ProvenanceErrorCode = "PROVENANCE_SEQ_REWRITE" | "PROVENANCE_HISTORY_UNREADABLE";

/** The journal's single error type: a code plus a human reason.
 * - PROVENANCE_SEQ_REWRITE: an explicit seq at or below the last one —
 *   provenance is forward-only and does not rewrite history.
 * - PROVENANCE_HISTORY_UNREADABLE: the journal exists but cannot be read
 *   (EACCES/EISDIR/EIO) or is corrupt (middle-line parse failure). Appending
 *   on top of an unreadable history would GUESS the next seq, and a guessed
 *   seq is how history becomes rewritable — so append refuses. */
export class ProvenanceError extends Error {
  readonly code: ProvenanceErrorCode;

  constructor(code: ProvenanceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProvenanceError";
    this.code = code;
  }
}

export interface ProvenanceJournal {
  /**
   * Append one entry. `when` and `seq` come from the journal (clock +
   * history); the caller supplies who/carrier/version. An explicit seq at
   * or below the last one is refused. An unreadable/corrupt history refuses
   * ANY append — never append on top of a view that may be truncated.
   */
  append(entry: { who: string; carrier: string; version: string }, explicitSeq?: number): Promise<ProvenanceEntry>;
  read(): Promise<ProvenanceRead>;
}

export function fileProvenanceJournal(stateDir: string, clock: Clock = systemClock): ProvenanceJournal {
  const filePath = path.join(stateDir, PROVENANCE_FILE);

  /** Read the raw file. Throws ProvenanceHistoryUnreadableError when the
   * journal exists but cannot be read or is corrupt. */
  async function readRaw(): Promise<{ exists: boolean; entries: ProvenanceEntry[] }> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { exists: false, entries: [] };
      throw new ProvenanceError("PROVENANCE_HISTORY_UNREADABLE", 
        `cannot read ${PROVENANCE_FILE} (${code ?? (err as Error).message}); ` +
          `unreadable is NOT genesis — the machine had the machinery and its record is hidden, not absent`,
      );
    }
    const lines = text.split("\n").filter((l) => l.trim());
    const entries: ProvenanceEntry[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      try {
        entries.push(JSON.parse(lines[i]!) as ProvenanceEntry);
      } catch {
        // Only the LAST non-empty line may be torn (crash mid-append). A
        // middle-line failure is corruption: everything after it is
        // unverifiable, and reading a truncated history as the truth is how
        // the seq gets re-issued.
        if (i < lines.length - 1) {
          throw new ProvenanceError("PROVENANCE_HISTORY_UNREADABLE", 
            `corrupt entry at line ${i + 1} (middle of the journal); history unreadable ≠ history short`,
          );
        }
        break;
      }
    }
    return { exists: true, entries };
  }

  return {
    async append(entry, explicitSeq) {
      await fs.mkdir(stateDir, { recursive: true });
      const { exists, entries } = await readRaw();
      const lastSeq = exists ? (entries.at(-1)?.seq ?? -1) : -1;
      const seq = explicitSeq ?? lastSeq + 1;
      if (seq <= lastSeq) {
        throw new ProvenanceError("PROVENANCE_SEQ_REWRITE", `seq ${seq} <= last ${lastSeq}; provenance is forward-only and does not rewrite history`);
      }
      const full: ProvenanceEntry = {
        seq,
        who: entry.who,
        carrier: entry.carrier,
        when: clock.nowMs(),
        version: entry.version,
      };
      const fh = await fs.open(filePath, "a");
      try {
        await fh.writeFile(`${JSON.stringify(full)}\n`);
        await fh.sync(); // durable BEFORE the action it records: same promise as the txn WAL
      } finally {
        await fh.close();
      }
      return full;
    },
    async read() {
      try {
        const { exists, entries } = await readRaw();
        return exists ? { kind: "observed" as const, entries } : { kind: "genesis" as const };
      } catch (err) {
        if (err instanceof ProvenanceError) {
          return { kind: "unreadable" as const, reason: err.message };
        }
        throw err;
      }
    },
  };
}

export interface ProvenanceSummary {
  /** Machines with an observed journal (any entry count). */
  recorded: number;
  /** Total entries across recorded machines. */
  reconciles: number;
  /** Machines with NO journal (genesis). MUST never be folded into recorded. */
  notObserved: number;
  /** Machines whose journal exists but cannot be read. NEVER recorded, and
   * NEVER notObserved — "I didn't see it" is not "it isn't there". */
  unreadable: number;
}

/**
 * Record one reconcile in the journal (used by createUpgrader before the
 * transaction). The VERSION comes from the release the reconcile drove —
 * the journal records what was attempted, not the caller's claim. Identity
 * defaults to the local operator.
 */
export async function recordReconcile(
  journal: ProvenanceJournal,
  identity: { who: string; carrier: string } | null | undefined,
  version: string,
): Promise<void> {
  const id = identity ?? { who: "local", carrier: "auto" };
  await journal.append({ who: id.who, carrier: id.carrier, version });
}

/**
 * Fleet aggregation of per-machine reads. The mechanical guards:
 *  - a genesis read counts in notObserved, never in recorded
 *  - an unreadable read counts in unreadable, never in recorded and never
 *    in notObserved
 * "No data" and "zero data" are different buckets, and "can't see" is a
 * third — any caller that merges them is the downgrade this module exists
 * to prevent.
 */
export function summarizeProvenance(reads: readonly ProvenanceRead[]): ProvenanceSummary {
  let recorded = 0;
  let reconciles = 0;
  let notObserved = 0;
  let unreadable = 0;
  for (const read of reads) {
    if (read.kind === "genesis") {
      notObserved += 1;
    } else if (read.kind === "unreadable") {
      unreadable += 1;
    } else {
      recorded += 1;
      reconciles += read.entries.length;
    }
  }
  return { recorded, reconciles, notObserved, unreadable };
}
