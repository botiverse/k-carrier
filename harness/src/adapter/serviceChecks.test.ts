// @invariant — adapter-mode service checks: the SAME assertions as the
// service teeth (upgrade / rollback / lifecycle-converged), host swapped
// for an external adopter adapter (archer: "同一套齿，换一个宿主实现").
// Known-green on a clean world, known-red under each declared mutation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAdapterServiceUpgrade,
  checkAdapterServiceRollback,
  checkAdapterLifecycleConverged,
  type ServiceAdapterFactory,
} from "./serviceChecks.ts";
import { createServiceAdapter } from "../fixtures/service-adapter.ts";
import { type ToothContext } from "../teeth/registry.ts";
import { createSandbox } from "../scenario/sandbox.ts";

const ctxFor = async (prefix: string): Promise<{ ctx: ToothContext; teardown: () => Promise<void> }> => {
  const sb = await createSandbox({ prefix });
  return { ctx: { profile: "service", sandboxDir: sb.dir }, teardown: sb.teardown };
};

const adapterFactory: ServiceAdapterFactory = (dir) => createServiceAdapter(dir);

test("known-green: adapter.service-upgrade promotes with a fresh incarnation, old verified dead", async () => {
  const { ctx, teardown } = await ctxFor("adapter-upgrade");
  try {
    await checkAdapterServiceUpgrade(ctx, adapterFactory);
  } finally {
    await teardown();
  }
});

test("known-red: adapter.service-upgrade catches a bad version (auto-rollback, no promote)", async () => {
  const { ctx, teardown } = await ctxFor("adapter-upgrade-red");
  try {
    // mutation: the served 2.0.0 cannot start — the adapter's probe fails,
    // auto-rollback, so the promote assertion goes RED
    await assert.rejects(
      checkAdapterServiceUpgrade(ctx, adapterFactory, { serveBadVersion: true }),
      /must promote/,
    );
  } finally {
    await teardown();
  }
});

test("known-green: adapter.service-rollback pulls the old version back AND running", async () => {
  const { ctx, teardown } = await ctxFor("adapter-rollback");
  try {
    await checkAdapterServiceRollback(ctx, adapterFactory);
  } finally {
    await teardown();
  }
});

test("known-red: adapter.service-rollback catches a good version (no rollback)", async () => {
  const { ctx, teardown } = await ctxFor("adapter-rollback-red");
  try {
    // mutation: a good version is served — it promotes, so the rollback
    // expectation goes RED
    await assert.rejects(
      checkAdapterServiceRollback(ctx, adapterFactory, { serveGoodVersion: true }),
      /must roll back/,
    );
  } finally {
    await teardown();
  }
});

test("known-green: adapter.lifecycle-converged promotes with a real convergence report", async () => {
  const { ctx, teardown } = await ctxFor("adapter-converged");
  try {
    await checkAdapterLifecycleConverged(ctx, adapterFactory);
  } finally {
    await teardown();
  }
});

test("known-red: adapter.lifecycle-converged catches a stale surface read-back", async () => {
  const { ctx, teardown } = await ctxFor("adapter-converged-red");
  try {
    // mutation: the surface reads back the OLD path — convergence fails
    await assert.rejects(
      checkAdapterLifecycleConverged(ctx, adapterFactory, { staleSurface: true }),
      /must promote|staleSurface => RED/,
    );
  } finally {
    await teardown();
  }
});
