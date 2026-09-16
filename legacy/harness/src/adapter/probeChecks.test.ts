// @invariant — adapter.service-probe-binds-live-process: evidence must come
// from the process that is running NOW. Known-green on a clean world, and red
// under both the declared mutation and the real defect it exists to catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAdapterProbeBindsLiveProcess } from "./probeChecks.ts";
import { type ServiceAdapterFactory } from "./serviceChecks.ts";
import { createServiceAdapter } from "../fixtures/service-adapter.ts";
import { type ToothContext } from "../teeth/registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";

const ctxFor = async (prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> => {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
};

const adapterFactory: ServiceAdapterFactory = (dir) => createServiceAdapter(dir);

/**
 * An adapter whose probe answers once and then repeats itself — the realistic
 * shape of this defect (a version file, a stale pidfile, a value remembered at
 * startup), and one that is invisible to every check that only ever looks at a
 * healthy machine.
 */
const cachingProbeAdapter: ServiceAdapterFactory = (dir) => {
  const real = createServiceAdapter(dir);
  let cached: Awaited<ReturnType<typeof real.healthProbe>> | null = null;
  return { ...real, healthProbe: async () => (cached ??= await real.healthProbe()) };
};

test("known-green: the probe describes the live incarnation", async () => {
  const { ctx, teardown } = await ctxFor("adapter-probe");
  try {
    await checkAdapterProbeBindsLiveProcess(ctx, adapterFactory);
  } finally {
    await teardown();
  }
});

test("known-red: catches a probe that CACHES its answer (the defect it exists for)", async () => {
  const { ctx, teardown } = await ctxFor("adapter-probe-cache");
  try {
    // A cached probe keeps describing a process that has been killed.
    await assert.rejects(
      checkAdapterProbeBindsLiveProcess(ctx, cachingProbeAdapter),
      /DEAD incarnation/,
    );
  } finally {
    await teardown();
  }
});

test("known-red: the kill is load-bearing (skipping it must break the check)", async () => {
  const { ctx, teardown } = await ctxFor("adapter-probe-nokill");
  try {
    // mutation: leave the incarnation alive. If the check still passed, its
    // green would not depend on the kill at all — it would be testing nothing.
    await assert.rejects(
      checkAdapterProbeBindsLiveProcess(ctx, adapterFactory, { skipKill: true }),
      /DEAD incarnation/,
    );
  } finally {
    await teardown();
  }
});
