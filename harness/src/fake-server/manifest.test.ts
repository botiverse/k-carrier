// @invariant — manifest is the L0 wire contract; its shape must never drift
// silently (it is what core's artifact layer will consume).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildManifest,
  compareVersions,
  sha256Hex,
} from "./manifest.ts";

test("buildManifest carries version and per-platform targets", () => {
  const m = buildManifest("1.2.3", {
    "darwin-arm64": { file: "app-1.2.3.bin", sha256: "abc", size: 12 },
  });
  assert.equal(m.version, "1.2.3");
  const target = m.targets["darwin-arm64"];
  assert.ok(target);
  assert.equal(target.file, "app-1.2.3.bin");
});

test("sha256Hex matches the well-known empty-string digest", () => {
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("compareVersions orders numeric dotted versions", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3", "1.10.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0); // missing segments count as 0
});
