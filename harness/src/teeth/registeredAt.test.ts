// @invariant — the case index must point at the case. An index that can drift
// is worse than no index: it is read as evidence and costs a grep to disprove.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import "./index.ts";
import { allTeeth } from "./registry.ts";

test("every tooth records where it was registered", () => {
  const missing = allTeeth().filter((t) => !t.registeredAt).map((t) => t.id);
  assert.deepEqual(missing, [], "teeth with no registration site");
});

test("every registration site is a real file:line whose registerTooth call is THIS tooth", () => {
  const wrong: string[] = [];
  const templated: string[] = [];
  for (const tooth of allTeeth()) {
    const site = tooth.registeredAt;
    if (!site) continue; // covered by the test above; not this one's subject
    const m = /^(.*):(\d+)$/.exec(site);
    if (!m) { wrong.push(`${tooth.id}: unparseable site ${site}`); continue; }
    const [, file, lineStr] = m;
    if (!existsSync(file!)) { wrong.push(`${tooth.id}: ${file} does not exist`); continue; }
    const lines = readFileSync(file!, "utf8").split("\n");
    const line = Number(lineStr);
    // The id is declared just inside the registerTooth({...}) call, so look at
    // a small window from the call line. Checking only "the file exists" would
    // pass for a pointer to the wrong tooth in the right file -- the drift
    // that actually happens.
    const window = lines.slice(line - 1, line + 6).join("\n");
    if (!window.includes("registerTooth(")) {
      wrong.push(`${tooth.id}: ${site} is not a registerTooth call`);
      continue;
    }
    // Identity check, where identity is checkable: a couple of teeth are
    // registered in a loop with a templated id, so their id literal is not in
    // the source at all. Those get the call-site check only -- and the count
    // is asserted below, so the weaker case cannot quietly grow.
    const text = readFileSync(file!, "utf8");
    if (text.includes(`"${tooth.id}"`) && !window.includes(`"${tooth.id}"`)) {
      wrong.push(`${tooth.id}: ${site} declares a different tooth`);
    } else if (!text.includes(`"${tooth.id}"`)) {
      templated.push(tooth.id);
    }
  }
  assert.deepEqual(wrong, [], "registration sites that do not point at their tooth");
  assert.deepEqual(
    templated.toSorted(),
    ["harness.teeth-present-service", "harness.teeth-present-swap"],
    "teeth exempt from the identity check (templated ids) — pin the list so it cannot grow unnoticed",
  );
});
