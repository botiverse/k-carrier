/** Fixture: pause the external runner AFTER stop completed, before start. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createOptions } from "../../../examples/external-service/adapter.ts";
import { createExternalUpgrader } from "../../../core/src/index.ts";
export default function create() {
  const options = createOptions();
  const stop = options.host.stop;
  options.host.stop = async (slot) => {
    await stop(slot);
    const dir = path.dirname(options.stateDir);
    if (slot === "stable" && await fs.stat(path.join(dir, "pause")).then(() => true, () => false)) {
      await fs.writeFile(path.join(dir, "stopped"), String(process.pid));
      for (;;) await sleep(100);
    }
  };
  return createExternalUpgrader(options);
}
