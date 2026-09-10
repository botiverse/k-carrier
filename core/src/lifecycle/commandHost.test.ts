/** @invariant A command controller must provide live identity and finish inside its budget. */
import test from "node:test";
import assert from "node:assert/strict";
import { createCommandHost } from "./commandHost.ts";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

test("command controller rejects malformed evidence, nonzero exit and hung commands", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "k-controller-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const controller = (code: string) => createCommandHost({ stateDir, command: [process.execPath, "-e", code], timeoutMs: 200 });
  await assert.rejects(controller('console.log(JSON.stringify({protocolVersion:1,ok:true,evidence:{version:"2"}}))').healthProbe(), /HOST_EVIDENCE_INVALID/);
  await assert.rejects(controller('process.exit(2)').stop("stable"), /HOST_COMMAND_FAILED/);
  await assert.rejects(controller('process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)').start("experiment"), /did not return within/);
  await assert.rejects(controller('console.log("not json")').quiesce());
});
