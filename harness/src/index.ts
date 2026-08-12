// Public API of @botiverse/k-carrier/harness — the acceptance harness.
//
// This barrel is the single supported entry point for the harness; deep
// imports into ./harness/src/** are internal and not part of the public API.
// The harness is also runnable as the `k-harness` bin.

// The black-box target contract an adopter ships (k.target.ts) and its loader.
export * from "./target.ts";

// The in-process fake host used to exercise an adapter deterministically.
export * from "./fake-host/inproc.ts";
