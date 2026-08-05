// @invariant — L0 channel semantics: latest | alpha | pinned:X with
// Version XOR Track; unknown channel values fail closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChannel, resolveTarget } from "./channel.ts";
import type { Manifest } from "./manifest.ts";

const PLATFORM = "darwin-arm64";

function manifest(version: string, channel?: "latest" | "alpha"): Manifest {
  const m: Manifest = {
    version,
    targets: { [PLATFORM]: { file: "app.bin", sha256: "a".repeat(64), size: 1 } },
  };
  if (channel !== undefined) m.channel = channel;
  return m;
}

test("parseChannel accepts the three forms and rejects everything else", () => {
  assert.equal(parseChannel("latest"), "latest");
  assert.equal(parseChannel("alpha"), "alpha");
  assert.equal(parseChannel("pinned:1.2.3"), "pinned:1.2.3");
  for (const bad of ["", "nightly", "PINNED:1.0.0", "pinned:", "latest ", "beta"]) {
    assert.throws(() => parseChannel(bad), /CHANNEL_INVALID/);
  }
});

test("latest resolves to the served manifest version (track resolution)", () => {
  const r = resolveTarget(manifest("3.0.0"), parseChannel("latest"), PLATFORM);
  assert.equal(r.version, "3.0.0");
  assert.equal(r.target.file, "app.bin");
});

test("pinned:X requires the served version to equal X (version resolution, not track)", () => {
  const r = resolveTarget(manifest("2.0.0"), parseChannel("pinned:2.0.0"), PLATFORM);
  assert.equal(r.version, "2.0.0");
  assert.throws(
    () => resolveTarget(manifest("2.0.0"), parseChannel("pinned:9.9.9"), PLATFORM),
    /PINNED_VERSION_MISMATCH/,
  );
});

test("alpha requires the served manifest to be an alpha release", () => {
  assert.throws(
    () => resolveTarget(manifest("2.0.0"), parseChannel("alpha"), PLATFORM),
    /NOT_ALPHA/,
  );
  const r = resolveTarget(manifest("2.0.0-alpha.1", "alpha"), parseChannel("alpha"), PLATFORM);
  assert.equal(r.version, "2.0.0-alpha.1");
});

test("an unknown platform key fails closed (UNSUPPORTED_PLATFORM)", () => {
  assert.throws(
    () => resolveTarget(manifest("1.0.0"), parseChannel("latest"), "windows-arm64"),
    /UNSUPPORTED_PLATFORM/,
  );
});
