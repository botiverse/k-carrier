/**
 * M6 mutation journals/summaries — the wrong behaviors each tooth's
 * negative control must catch (one per conjunct, the AND-gate rule).
 * Kept separate from m6.ts so both files stay under the line budget.
 */
import { promises as fs } from "node:fs";
import {
  ProvenanceError,
  summarizeProvenance,
  type ProvenanceJournal,
  type ProvenanceEntry,
  type ProvenanceRead,
  type ProvenanceSummary,
} from "../../../core/src/provenance/journal.ts";

/** Mutation journal: reuses an existing seq (history can be collapsed). */
export function reuseSeqJournal(): ProvenanceJournal {
  const entries: ProvenanceEntry[] = [];
  return {
    async append(entry, explicitSeq) {
      const full: ProvenanceEntry = { seq: explicitSeq ?? 0, who: entry.who, carrier: entry.carrier, when: 0, version: entry.version };
      entries.push(full);
      return full;
    },
    async read() {
      return { kind: "observed", entries };
    },
  };
}

/** Mutation journal: accepts a duplicate seq (rewrites history). */
export function acceptingJournal(): ProvenanceJournal {
  let seq = -1;
  const entries: ProvenanceEntry[] = [];
  return {
    async append(entry, explicitSeq) {
      const next = explicitSeq ?? seq + 1;
      seq = Math.max(seq, next);
      const full: ProvenanceEntry = { seq: next, who: entry.who, carrier: entry.carrier, when: 0, version: entry.version };
      entries.push(full);
      return full;
    },
    async read() {
      return { kind: "observed", entries };
    },
  };
}

/** Mutation journal: read keeps a torn (unparsed) final line. */
export function keepTornJournal(inner: ProvenanceJournal, file: string): ProvenanceJournal {
  return {
    append: (e, s) => inner.append(e, s),
    async read() {
      const base = await inner.read();
      if (base.kind !== "observed") return base;
      const text = await fs.readFile(file, "utf8");
      const lines = text.split("\n").filter((l) => l.trim());
      const entries: ProvenanceEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as ProvenanceEntry);
        } catch {
          // mutation: the torn line is KEPT as an entry — history now
          // contains something that never completed
          entries.push({ seq: 99, who: "torn", carrier: "torn", when: 0, version: "torn" });
        }
      }
      return { kind: "observed", entries };
    },
  };
}

/** Mutation journal: appends even when the history is unreadable/corrupt —
 * the wrong behavior the tooth guards against. Delegates to the real
 * journal until the corruption, then GUESSES the next seq (the
 * rewrite-under-a-truncated-view attack) instead of refusing. */
export function appendOnCorruptJournal(file: string, inner: ProvenanceJournal): ProvenanceJournal {
  return {
    async append(entry, explicitSeq) {
      try {
        return await inner.append(entry, explicitSeq);
      } catch (err) {
        if (err instanceof ProvenanceError && err.code === "PROVENANCE_HISTORY_UNREADABLE") {
          const full: ProvenanceEntry = { seq: explicitSeq ?? 0, who: entry.who, carrier: entry.carrier, when: 0, version: entry.version };
          await fs.appendFile(file, `${JSON.stringify(full)}\n`);
          return full;
        }
        throw err;
      }
    },
    async read() {
      return inner.read();
    },
  };
}

/** Mutation journal: reports genesis for an empty-but-present journal. */
export function emptyAsGenesisJournal(): ProvenanceJournal {
  return {
    async append(): Promise<ProvenanceEntry> {
      throw new Error("unused");
    },
    async read() {
      return { kind: "genesis" };
    },
  };
}

/** Mutation summary: folds the unreadable bucket into notObserved. */
export function mergeUnreadableSummary(reads: readonly ProvenanceRead[]): ProvenanceSummary {
  const base = summarizeProvenance(reads);
  return {
    recorded: base.recorded,
    reconciles: base.reconciles,
    notObserved: base.notObserved + base.unreadable,
    unreadable: 0,
  };
}

/** Mutation journal: entries are only durable AFTER the outcome (not
 * write-ahead) — the wrong wiring the tooth guards against. */
export function promoteOnlyJournal(inner: ProvenanceJournal): ProvenanceJournal & { flush(): Promise<void> } {
  const buffered: Array<{ who: string; carrier: string; version: string }> = [];
  return {
    async append(entry) {
      buffered.push({ ...entry });
      return { seq: buffered.length - 1, ...entry, when: 0 };
    },
    async read() {
      return { kind: "observed", entries: [] }; // nothing durable until flushed
    },
    async flush() {
      for (const b of buffered) await inner.append(b);
    },
  };
}
