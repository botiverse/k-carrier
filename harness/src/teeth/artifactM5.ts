/**
 * M5 platform-surface / lifecycle-convergence teeth (test-plan M5 rows).
 * Registration site only — check bodies live in harness/src/artifact/m5.ts.
 */
import { registerTooth } from "./registry.ts";
import {
  checkM5LifecycleSurfaceAllowlist,
  checkM5LifecycleConvergedPromotes,
  checkM5LifecycleProjectionBan,
  checkM5LifecycleFailClosedRetirement,
} from "../artifact/m5.ts";

registerTooth({
  id: "m5.lifecycle-surface-allowlist",
  profiles: ["service"],
  layers: ["L3"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "an unregistered (or unreadable) surface vouches for convergence",
      caughtOnlyBy: "this", // only this tooth pins the allowlist trust boundary
    },
  ],
  run: checkM5LifecycleSurfaceAllowlist,
});

registerTooth({
  id: "m5.lifecycle-converged-promotes",
  profiles: ["service"],
  layers: ["L3"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "a stale surface read-back still allows the promote",
      caughtOnlyBy: "this", // only this tooth pins convergence before promote
    },
  ],
  run: checkM5LifecycleConvergedPromotes,
});

registerTooth({
  id: "m5.lifecycle-projection-ban",
  profiles: ["service"],
  layers: ["L3"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "a version/metadata string satisfies host_lifecycle_converged",
      caughtOnlyBy: "this", // only this tooth pins the projection ban
    },
  ],
  run: checkM5LifecycleProjectionBan,
});

registerTooth({
  id: "m5.lifecycle-fail-closed-retirement",
  profiles: ["service"],
  layers: ["L3"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "the legacy lifecycle manager is retired before convergence passed",
      caughtOnlyBy: "this", // only this tooth pins the retirement order
    },
  ],
  run: checkM5LifecycleFailClosedRetirement,
});

