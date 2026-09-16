// @invariant — manifest target selection. The Rosetta case is the whole
// reason this is a function instead of a template string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { platformKeyFor } from "./posix.ts";

const yes = (): boolean => true;
const no = (): boolean => false;

test("ordinary machines report platform-arch unchanged", () => {
  assert.equal(platformKeyFor("linux", "x64", no), "linux-x64");
  assert.equal(platformKeyFor("linux", "arm64", no), "linux-arm64");
  assert.equal(platformKeyFor("darwin", "arm64", yes), "darwin-arm64");
});

test("x64 Node on arm64 Mac hardware selects the arm64 target", () => {
  // Under Rosetta process.arch lies about the machine. The naive key would
  // pin this Mac to the x64 build permanently, and nothing would ever look
  // wrong: an x64 binary runs fine there.
  assert.equal(platformKeyFor("darwin", "x64", yes), "darwin-arm64");
});

test("a genuine Intel Mac still gets x64", () => {
  // The hardware probe is what separates this from the case above — without
  // it the two are indistinguishable, and one of them would be wrong.
  assert.equal(platformKeyFor("darwin", "x64", no), "darwin-x64");
});

test("the probe is consulted ONLY on darwin+x64", () => {
  // A probe that ran everywhere would shell out on every platform lookup,
  // and on Linux it would answer about a key that does not exist there.
  const calls: string[] = [];
  const probe = (): boolean => { calls.push("called"); return true; };
  platformKeyFor("linux", "x64", probe);
  platformKeyFor("darwin", "arm64", probe);
  platformKeyFor("win32", "x64", probe);
  assert.deepEqual(calls, [], "probe must not run off the darwin+x64 path");
  platformKeyFor("darwin", "x64", probe);
  assert.deepEqual(calls, ["called"]);
});
