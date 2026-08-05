/**
 * M0 teeth — fake-server + scenario sandbox acceptance (test-plan M0 rows:
 * "fake 静态 server（manifest+工件+签名，可篡改）| 正常链路可走通 | 篡改任一字节
 * ⇒ 下游校验齿红"; harness-design §1.2/§1.3).
 *
 * The check bodies live in checks.ts (imported here); this module is the
 * registration site — importing it registers every M0 tooth, and the
 * registry forces profiles, invariant/baseline dichotomy and an answered
 * must-red list (harness-design §1.5). Tests import this module for the
 * side effect and drive known-green/known-red through the exported checks.
 */
import { registerTooth } from "./registry.ts";
import {
  checkServesVerifiableRelease,
  checkCorruptByteRejects,
  checkSwapSigRejects,
  checkServeOlderVersion,
  checkDropFileRemoves,
  checkSandboxIsolation,
  checkSandboxVerifyDead,
} from "./checks.ts";

registerTooth({
  id: "fake-server.serves-verifiable-release",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "serve a release whose artifacts have no .sig files",
      caughtOnlyBy: "this", // no other tooth checks publish-time chain completeness
    },
    {
      mutate: "point the manifest target at a different artifact than the signed one",
      caughtOnlyBy: {
        alsoCaughtBy: "core artifact L0 sha256 integrity check (when landed)",
        whyStillNeeded:
          "this tooth is the harness's own上岗证: it pins the fake-server publish/serve wiring now, before any core exists",
      },
    },
  ],
  run: checkServesVerifiableRelease,
});

registerTooth({
  id: "fake-server.tamper-corrupt-byte",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "corruptByte is a no-op that leaves the served bytes unchanged",
      caughtOnlyBy: "this", // only this tooth asserts the tamper had a verifiable effect
    },
  ],
  run: checkCorruptByteRejects,
});

registerTooth({
  id: "fake-server.tamper-swap-sig",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "swapSig serves each artifact its own signature",
      caughtOnlyBy: "this", // only this tooth asserts the swap is a real cross-swap
    },
  ],
  run: checkSwapSigRejects,
});

registerTooth({
  id: "fake-server.tamper-serve-older-version",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "serveOlderVersion keeps serving the current version",
      caughtOnlyBy: "this", // only this tooth asserts the downgrade actually downgrades
    },
  ],
  run: checkServeOlderVersion,
});

registerTooth({
  id: "fake-server.tamper-drop-file",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0", "L0.5"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "dropFile keeps serving the dropped file",
      caughtOnlyBy: "this", // only this tooth asserts the file is truly gone for clients
    },
  ],
  run: checkDropFileRemoves,
});

registerTooth({
  id: "scenario.sandbox-verify-dead",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "teardown sends kill but never scans/verifies death (residual marker process survives)",
      caughtOnlyBy: "this", // only this tooth proves "发了 kill"≠"死了" at the sandbox boundary
    },
  ],
  run: checkSandboxVerifyDead,
});

registerTooth({
  id: "scenario.sandbox-isolation",
  profiles: ["cli", "daemon", "managed"],
  layers: ["L0"],
  kind: { kind: "invariant" },
  mustRed: [
    {
      mutate: "two live sandboxes share the same temp dir",
      caughtOnlyBy: "this", // harness-internal discipline; no downstream check sees the dirs
    },
    {
      mutate: "two live sandboxes share the same port",
      caughtOnlyBy: "this", // parallel-scenario collisions are invisible to any product tooth
    },
    {
      mutate: "teardown leaves the sandbox dir on disk",
      caughtOnlyBy: "this", // "沙箱边界即清场边界"; nothing downstream re-checks残留
    },
  ],
  run: checkSandboxIsolation,
});
