// @invariant — L0 manifest parsing is strict and fail-closed: malformed
// shapes and unknown channel values are typed errors, never silent
// reinterpretation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "./manifest.ts";

const VALID = JSON.stringify({
  version: "1.2.3",
  targets: {
    "darwin-arm64": { file: "app-1.2.3.bin", sha256: "a".repeat(64), size: 42 },
  },
});

test("parses a valid manifest with version, targets and optional channel", () => {
  const m = parseManifest(VALID);
  assert.equal(m.version, "1.2.3");
  const target = m.targets["darwin-arm64"];
  assert.ok(target);
  assert.equal(target.file, "app-1.2.3.bin");
  assert.equal(m.channel, undefined);
  const alpha = parseManifest(JSON.stringify({ ...JSON.parse(VALID), channel: "alpha" }));
  assert.equal(alpha.channel, "alpha");
});

test("rejects malformed shapes with MANIFEST_INVALID", () => {
  for (const bad of [
    "not json",
    "42",
    JSON.stringify({}),
    JSON.stringify({ version: "", targets: {} }),
    JSON.stringify({ version: "1.0.0", targets: { p: { file: "", sha256: "a".repeat(64), size: 1 } } }),
    JSON.stringify({ version: "1.0.0", targets: { p: { file: "x", sha256: "not-hex", size: 1 } } }),
    JSON.stringify({ version: "1.0.0", targets: { p: { file: "x", sha256: "a".repeat(64), size: -1 } } }),
    JSON.stringify({ version: "1.0.0", targets: {} }),
  ]) {
    assert.throws(() => parseManifest(bad), /MANIFEST_INVALID/);
  }
});

test("unknown channel value fails closed", () => {
  assert.throws(
    () => parseManifest(JSON.stringify({ ...JSON.parse(VALID), channel: "nightly" })),
    /CHANNEL_INVALID/,
  );
});
