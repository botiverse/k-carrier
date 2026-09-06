import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createExternalUpgrader, createCommandHost } from "../../core/src/index.ts";
import type { Release } from "../../core/src/index.ts";

/** This trusted module is bundled into the disposable helper at BUILD time. */
export function createOptions() {
  const dir = process.env.K_EXAMPLE_HOME;
  if (!dir) throw new Error("set K_EXAMPLE_HOME to the example directory");
  const stateDir = resolve(dir, "k");
  const host = createCommandHost({ stateDir,
    command: [process.execPath, resolve(dir, "controller.mjs"), dir] });
  return { stateDir, host, policy: "confirm" as const, notificationSink: async () => {},
    source: {
      checkForUpdate: async () => null,
      fetchRelease: async (version: string) => {
        const manifest = JSON.parse(await readFile(resolve(dir, "release.json"), "utf8")) as Release;
        if (manifest.version !== version) throw new Error("requested version is unavailable");
        return manifest;
      },
    },
  };
}

export default function create() { return createExternalUpgrader(createOptions()); }
