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
  assert.equal(m.channels, undefined);
  // channel NAMES are the publisher's vocabulary: any name parses.
  const streams = parseManifest(
    JSON.stringify({ ...JSON.parse(VALID), channels: { stable: "1.2.3", "lts-2024": "1.0.0" } }),
  );
  assert.deepEqual(streams.channels, { stable: "1.2.3", "lts-2024": "1.0.0" });
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

test("channel NAMES are the publisher's vocabulary; only the SHAPE is validated", () => {
  // Any name is legitimate — K invents no channel vocabulary.
  const ok = parseManifest(
    JSON.stringify({ ...JSON.parse(VALID), channels: { nightly: "1.2.3", "lts-2024": "1.0.0" } }),
  );
  assert.equal(ok.channels?.["nightly"], "1.2.3");
  // Malformed SHAPE still fails closed.
  assert.throws(
    () => parseManifest(JSON.stringify({ ...JSON.parse(VALID), channels: ["stable"] })),
    /MANIFEST_INVALID/,
  );
  assert.throws(
    () => parseManifest(JSON.stringify({ ...JSON.parse(VALID), channels: { stable: 42 } })),
    /MANIFEST_INVALID/,
  );
});
