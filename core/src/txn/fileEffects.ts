/**
 * Filesystem-backed TxnEffects: the real journal and slot store.
 *
 * Layout under stateDir:
 *   journal.jsonl        append-only, one intent per line, fsync'd before return
 *   slots/stable/        the trusted version's bytes
 *   slots/experiment/    the version on trial
 *   slots/<slot>/VERSION the version string held by that slot
 *
 * Durability is the whole point of this file: appendAndSync must not resolve
 * until the entry survives a power cut, or the WAL guarantee the engine
 * depends on is a fiction.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JournalEntry } from "./state.ts";
import type { JournalStore, SlotStore, TxnEffects } from "./effects.ts";
import type { Slot } from "../lifecycle/hostAdapter.ts";
import { platformOpsFor } from "../platform/index.ts";

const JOURNAL = "journal.jsonl";
const VERSION_FILE = "VERSION";
const ARTIFACT_FILE = "artifact.bin";

function slotDir(stateDir: string, slot: Slot): string {
  return path.join(stateDir, "slots", slot);
}

export function fileJournalStore(stateDir: string): JournalStore {
  const journalPath = path.join(stateDir, JOURNAL);
  return {
    async appendAndSync(entry: JournalEntry): Promise<void> {
      await fs.mkdir(stateDir, { recursive: true });
      const fh = await fs.open(journalPath, "a");
      try {
        await fh.writeFile(`${JSON.stringify(entry)}\n`);
        await fh.sync(); // durable BEFORE we return: the WAL promise
      } finally {
        await fh.close();
      }
    },
    async readAll(): Promise<JournalEntry[]> {
      let text: string;
      try {
        text = await fs.readFile(journalPath, "utf8");
      } catch {
        return [];
      }
      const out: JournalEntry[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as JournalEntry);
        } catch {
          // A torn final line is expected after a crash mid-append: the entry
          // never completed, so it never happened. Earlier lines stand.
          break;
        }
      }
      return out;
    },
  };
}

export function fileSlotStore(stateDir: string): SlotStore {
  async function readVersion(slot: Slot): Promise<string | null> {
    try {
      return (await fs.readFile(path.join(slotDir(stateDir, slot), VERSION_FILE), "utf8")).trim();
    } catch {
      return null;
    }
  }

  return {
    async stageExperiment(artifact: { version: string; bytesRef: string }): Promise<void> {
      const dir = slotDir(stateDir, "experiment");
      const staging = `${dir}.staging`;
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(staging, { recursive: true });
      // bytesRef is a path to the verified bytes the caller downloaded.
      await fs.copyFile(artifact.bytesRef, path.join(staging, ARTIFACT_FILE));
      await fs.writeFile(path.join(staging, VERSION_FILE), artifact.version);
      // Publish the slot atomically: a half-written experiment must never be
      // visible as a stageable slot.
      await fs.rm(dir, { recursive: true, force: true });
      await platformOpsFor().renamePath(staging, dir);
    },

    async slotVersions(): Promise<Record<Slot, string | null>> {
      return { stable: await readVersion("stable"), experiment: await readVersion("experiment") };
    },

    async promoteExperiment(): Promise<void> {
      const experiment = slotDir(stateDir, "experiment");
      const stable = slotDir(stateDir, "stable");
      if ((await readVersion("experiment")) === null) return; // idempotent redo
      await fs.rm(`${stable}.old`, { recursive: true, force: true });
      await platformOpsFor().renamePath(stable, `${stable}.old`).catch(() => {});
      await platformOpsFor().renamePath(experiment, stable);
      await fs.rm(`${stable}.old`, { recursive: true, force: true });
    },

    async clearExperiment(): Promise<void> {
      await fs.rm(slotDir(stateDir, "experiment"), { recursive: true, force: true });
    },
  };
}

export function fileEffects(stateDir: string): TxnEffects {
  return { journal: fileJournalStore(stateDir), slots: fileSlotStore(stateDir) };
}

/** Path of the executable a slot holds, for hosts that need to launch it. */
export function slotArtifactPath(stateDir: string, slot: Slot): string {
  return path.join(slotDir(stateDir, slot), ARTIFACT_FILE);
}

/** Write verified bytes into the slot layout and mark them executable. */
export async function materializeArtifact(
  stateDir: string,
  bytes: Uint8Array,
): Promise<string> {
  const tmpDir = path.join(stateDir, "incoming");
  await fs.mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, ARTIFACT_FILE);
  await platformOpsFor().swapExecutable(target, bytes);
  await platformOpsFor().makeExecutable(target);
  return target;
}
