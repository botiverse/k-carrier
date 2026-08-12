/**
 * Out-of-band process scan by marker token (the verify-dead primitive).
 * Split from sandbox.ts, which owns the marker CONVENTION (see MARKER_ENV
 * there: one literal token `NAME=value`, carried on BOTH env and argv).
 */
import { execFileSync } from "node:child_process";

/**
 * All pids observably carrying the marker token `NAME=value` — the
 * sandbox-marker scan behind verify-dead.
 *
 * POSIX reads `ps eaxo pid=,command=`: the `e` flag appends each process's
 * environment to its command line, so BOTH marker channels (env + argv) land
 * in the same scanned text, and the marker survives the parent dying
 * (orphans/zombies the host no longer tracks).
 *
 * Windows enumerates `Win32_Process` via PowerShell/CIM: only `CommandLine`
 * is public there, so the ARGV channel is what makes a process claimable —
 * which is exactly why the marker rides two channels.
 */
export function findPidsByMarkerToken(name: string, value: string): number[] {
  const token = `${name}=${value}`;
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress -Depth 1",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed]; // ConvertTo-Json unwraps single rows
    const pids: number[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const pid = (row as { ProcessId?: unknown }).ProcessId;
      const commandLine = (row as { CommandLine?: unknown }).CommandLine;
      if (typeof pid !== "number" || typeof commandLine !== "string") continue;
      if (commandLine.includes(token)) pids.push(pid);
    }
    return pids;
  }
  const out = execFileSync("ps", ["eaxo", "pid=,command="], { encoding: "utf8" });
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    if (!line.includes(token)) continue;
    const m = /^\s*(\d+)/.exec(line);
    const pid = m?.[1];
    if (pid) pids.push(Number(pid));
  }
  return pids;
}
