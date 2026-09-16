/**
 * M6 drive mutation wrappers — the wrong behaviors each negative control
 * must catch (a gate that bricks a machine mid-transaction; an auto-
 * rollback gated on consent). Kept separate from m6Drive.ts for the line
 * budget.
 */
import type { Upgrader } from "../../../core/src/upgrader.ts";
import type { makeUpgrader } from "./m6.ts";
import { staticManifestSource } from "../../../core/src/artifact/staticManifestSource.ts";
import type { ReleaseSource } from "../../../core/src/artifact/source.ts";
import type { FakeServer } from "../fake-server/server.ts";

type UpgraderInstance = Awaited<ReturnType<typeof makeUpgrader>>;

/** Mutation: the gate holds a machine mid-transaction (the brick). */
export function holdingRollback(inner: UpgraderInstance): Upgrader {
  return {
    ...inner,
    async rollback() {
      return { held: "this install is managed by another manager; it does not roll itself back" };
    },
  };
}

/** Mutation: the in-transaction auto-rollback is gated on confirm — the
 * wrong behavior the controlling twin guards against. */
export function gatedAutoRollbackUpgrader(
  inner: UpgraderInstance,
  sink: (e: { kind: string; detail: Record<string, string> }) => Promise<void>,
): Upgrader {
  return {
    ...inner,
    async upgradeTo(version, opts2) {
      const r = await inner.upgradeTo(version, opts2);
      if (r.result === "rolled-back") {
        await sink({ kind: "confirm-request", detail: { version } });
        return { result: "held", reason: "auto-rollback requires consent", report: null };
      }
      return r;
    },
  };
}

/** A source that routes each requested version to the server serving it
 * (a FakeServer serves ONE manifest; a multi-version source needs routing). */
export function versionRoutingSource(routes: Record<string, FakeServer>): ReleaseSource {
  return {
    async checkForUpdate() {
      return null;
    },
    async fetchRelease(version, ctx) {
      const server = routes[version];
      if (!server) throw new Error(`no routed server serves ${version}`);
      return staticManifestSource({ baseUrl: server.url }).fetchRelease(version, ctx);
    },
  };
}

/** Mutation source: serves 3.0.0 for ANY request — the wrong source that
 * would install a different version than the one approved. */
export function wrongVersionSource(server: FakeServer): ReleaseSource {
  return {
    async checkForUpdate() {
      return null;
    },
    async fetchRelease(_version, ctx) {
      return staticManifestSource({ baseUrl: server.url }).fetchRelease("3.0.0", ctx);
    },
  };
}
