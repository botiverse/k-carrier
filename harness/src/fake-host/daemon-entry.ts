/**
 * Real fake-daemon process entry (harness-design §1.1).
 *
 * Spawned as an actual OS process so kill -9, dual-run detection and probe
 * liveness are tested against process reality — mocked crashes test nothing.
 * Writes a pid/startId file for out-of-band liveness inspection and answers
 * probes over a tiny line protocol on stdin/stdout.
 */
import { writeFileSync } from "node:fs";

const version = process.env["K_FAKE_VERSION"] ?? "0.0.0";
const slot = process.env["K_FAKE_SLOT"] ?? "stable";
const evidenceFile = process.env["K_FAKE_EVIDENCE_FILE"];
// startId must be unique per incarnation: pid alone is reusable by the OS.
const startId = `${process.pid}-${process.hrtime.bigint().toString(36)}`;

if (evidenceFile !== undefined) {
  writeFileSync(evidenceFile, JSON.stringify({ version, slot, pid: process.pid, startId }));
}

process.stdout.write(`ready ${JSON.stringify({ version, slot, pid: process.pid, startId })}\n`);

process.stdin.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    const cmd = line.trim();
    if (cmd === "probe") {
      process.stdout.write(`evidence ${JSON.stringify({ version, pid: process.pid, startId })}\n`);
    } else if (cmd === "exit") {
      process.exit(0);
    } else if (cmd === "hang") {
      // Simulates a host that never completes an operation; the harness must
      // time out and kill rather than wait forever.
      setInterval(() => {}, 1 << 30);
    }
  }
});

// Keep the process alive until told otherwise.
setInterval(() => {}, 1 << 30);
