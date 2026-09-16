import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SimulationResult } from "./run.ts";

interface FailureRecord {
  seed: number;
  failure: string;
  replay: string;
  transcriptSha256: string;
}

interface FailureCorpus {
  formatVersion: 1;
  failures: FailureRecord[];
}

/**
 * Atomically merge failures into a replay corpus. There are deliberately no
 * timestamps: the same failure set produces the same bytes.
 */
export async function recordFailures(filePath: string, results: readonly SimulationResult[]): Promise<number> {
  const failures = results.filter(
    (result): result is SimulationResult & { failure: string } => result.failure !== null,
  );
  if (failures.length === 0) return 0;

  let existing: FailureCorpus = { formatVersion: 1, failures: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (isFailureCorpus(parsed)) existing = parsed;
    else throw new Error("existing failure corpus has an unsupported shape");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const byKey = new Map(
    existing.failures.map((failure) => [`${failure.seed}:${failure.transcriptSha256}`, failure] as const),
  );
  for (const result of failures) {
    const record: FailureRecord = {
      seed: result.seed,
      failure: result.failure,
      replay: result.replay,
      transcriptSha256: result.transcriptSha256,
    };
    byKey.set(`${record.seed}:${record.transcriptSha256}`, record);
  }
  const corpus: FailureCorpus = {
    formatVersion: 1,
    failures: [...byKey.values()].toSorted(
      (left, right) => left.seed - right.seed || left.transcriptSha256.localeCompare(right.transcriptSha256),
    ),
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
  return failures.length;
}

function isFailureCorpus(value: unknown): value is FailureCorpus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { formatVersion?: unknown; failures?: unknown };
  if (candidate.formatVersion !== 1 || !Array.isArray(candidate.failures)) return false;
  return candidate.failures.every((failure) => {
    if (typeof failure !== "object" || failure === null) return false;
    const item = failure as Partial<FailureRecord>;
    return (
      typeof item.seed === "number" &&
      typeof item.failure === "string" &&
      typeof item.replay === "string" &&
      typeof item.transcriptSha256 === "string"
    );
  });
}
