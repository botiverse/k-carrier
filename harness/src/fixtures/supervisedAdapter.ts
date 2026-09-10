/** Fault injection around real production host calls; used only by process tests. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createOptions } from "../../../examples/external-service/adapter.ts";
import { createRunner } from "../../../core/src/index.ts";
const hang = async (): Promise<never> => { for (;;) await sleep(100); };
export default function create() {
  const options = createOptions();
  const dir = path.dirname(options.stateDir);
  const faultPath = path.join(dir, "fault");
  const fault = () => fs.readFile(faultPath, "utf8").catch(() => "");
  const stop = options.host.stop;
  options.host.stop = async (slot) => {
    await stop(slot);
    const mode = await fault();
    if (slot === "stable" && ["stop-crash", "stop-hang", "recovery-hang"].includes(mode)) {
      await fs.writeFile(path.join(dir, "stopped"), String(process.pid));
      if (mode === "stop-hang") return hang();
      process.exit(77);
    }
  };
  let attempting = false;
  const resume = options.host.resume;
  options.host.resume = async () => {
    if (attempting && await fault() === "resume-once") {
      await fs.unlink(faultPath);
      return hang();
    }
    return resume();
  };
  const fence = options.host.fence!;
  options.host.fence = async () => {
    if (await fault() === "recovery-hang" && await fs.stat(path.join(dir, "stopped")).then(() => true, () => false)) return hang();
    return fence();
  };
  const fetch = options.source.fetchRelease;
  options.source.fetchRelease = async (version) => {
    attempting = true;
    await fs.appendFile(path.join(dir, "fetches"), `${version}\n`);
    return fetch(version);
  };
  const runner = createRunner(options);
  const upgradeTo = runner.upgradeTo;
  runner.upgradeTo = async (...args) => {
    const outcome = await upgradeTo(...args);
    if (await fault() === "report-crash") { await fs.unlink(faultPath); process.exit(78); }
    return outcome;
  };
  return runner;
}
