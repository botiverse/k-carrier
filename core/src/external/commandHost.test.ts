/** @invariant A command controller must provide live identity and finish inside its budget. */
import test from "node:test";
import assert from "node:assert/strict";
import { createCommandHost } from "./commandHost.ts";

const makeController = (code: string) => createCommandHost({ stateDir: "/unused", command: [process.execPath, "-e", code], timeoutMs: 100 });
test("command controller rejects malformed evidence, nonzero exit and hung commands", async () => {
  const controller = makeController;
  await assert.rejects(controller('console.log(JSON.stringify({protocolVersion:1,ok:true,evidence:{version:"2"}}))').healthProbe(), /HOST_EVIDENCE_INVALID/);
  await assert.rejects(controller('process.exit(2)').stop("stable"), /HOST_COMMAND_FAILED/);
  await assert.rejects(controller('setInterval(()=>{},1000)').start("experiment"), /HOST_COMMAND_FAILED/);
  await assert.rejects(controller('console.log("not json")').quiesce());
});
