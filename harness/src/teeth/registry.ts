/**
 * Teeth registry — the discipline carrier of the harness (harness-design §1.5).
 *
 * A tooth is a named, profile-tagged check with a declared way to fail.
 * Registration IS the enforcement point: a tooth missing any discipline
 * field (profile tags, invariant/baseline dichotomy, must-red list, layer
 * declaration) is rejected at registration time with a typed error — it
 * never becomes a silently weaker test.
 *
 * Rules enforced here (each has a test):
 *  - unique, well-formed id
 *  - non-empty profile set
 *  - kind = invariant | baseline-with-failure-condition (no untagged
 *    implementation-locking assertions — Raft spec #395 dichotomy)
 *  - must-red: >= 1 entry, and each entry answers "who else would catch
 *    this mutation?" — "this" (nobody else) or a justified alsoCaughtBy
 *  - profile/layer tiering: a tooth may only be tagged with profiles whose
 *    layer set covers every layer the tooth exercises (the tier-boundary
 *    rule: a cli-profile tooth exercising L2 is a registration error)
 */

/**
 * A profile is a PROCESS MODEL, defined by cardinality: how many live
 * incarnations K itself manages.
 *
 *   swap     0 — K replaces bytes and touches no process. The user may run N
 *                concurrently at mixed versions; that is normal and invisible
 *                to K. (A one-shot CLI and a long-running interactive session
 *                are the SAME here — surprising, but correct: neither has a
 *                process K hands over.)
 *   service  1 — K stops one incarnation and starts another, briefly 0.
 *
 * There is no third model. Workload preservation, OS lifecycle convergence and
 * fleet drive are CAPABILITIES an adopter opts into, not another kind of
 * process — bundling them as a profile confused "what the app does" with "what
 * K does", which is not K's business.
 */
export type Profile = "swap" | "service";

/**
 * Opt-in capabilities, declared separately from the process model.
 *
 * A capability only belongs here once at least one tooth declares it.
 * Selecting a capability that no tooth answers adds ZERO checks while looking
 * like added assurance -- the empty-suite false-green this harness exists to
 * prevent. `workload-preservation` was removed on those grounds (08-05): no
 * tooth claimed it, and raft-computer, the host it was imagined for, restarts
 * its workloads rather than preserving them (xxchan: resume is enough).
 * `core/src/invariants.ts` still exports `workloadPreserved` for a host that
 * genuinely has continuity; it just is not a capability you can select yet.
 */
export type Capability =
  | "lifecycle-convergence" // OS lifecycle surfaces must read back (L3 platform)
  | "fleet-drive";          // server-pushed commands, policy-gated (L5)

export const ALL_CAPABILITIES: readonly Capability[] = [
  "lifecycle-convergence",
  "fleet-drive",
];

/** L1p = the simplified cli-profile slot model ("swap is promote"). */
export type Layer = "L0" | "L0.5" | "L1p" | "L1" | "L2" | "L3" | "L4" | "L5";

/** Which layers each profile is allowed to exercise (design §2.5). */
/**
 * Profiles name PROCESS MODELS, not program archetypes:
 *   swap    no live process K hands over. Bytes are replaced and take effect
 *           on the next start. Several old-version processes may keep running
 *           concurrently — that is normal, and invisible to K.
 *   service exactly one live incarnation is handed over: stop old, start new,
 *           prove it. This is where never-dual-run has meaning.
 *   hosted  a service that also holds someone else's work (sessions/jobs) and
 *           OS lifecycle state that must converge.
 */
export const PROFILE_LAYERS: Record<Profile, ReadonlySet<Layer>> = {
  swap: new Set<Layer>(["L0", "L0.5", "L1p"]),
  service: new Set<Layer>(["L0", "L0.5", "L1p", "L1", "L2", "L3", "L4", "L5"]),
};

export type ToothKind =
  | { kind: "invariant" }
  | { kind: "baseline"; failureCondition: string };

export type CaughtOnlyBy =
  | "this"
  | { alsoCaughtBy: string; whyStillNeeded: string };

export interface MustRed {
  /** The mutation that must turn this tooth red, stated concretely. */
  mutate: string;
  /** "this" = nobody else catches it; otherwise justify why the tooth still earns its keep. */
  caughtOnlyBy: CaughtOnlyBy;
}

/** Execution context handed to a tooth run. Grows with the harness. */
export interface ToothContext {
  profile: Profile;
  sandboxDir: string;
}

export interface ToothSpec {
  id: string;
  profiles: Profile[];
  /**
   * Only runs when the adopter has opted into this capability. Absent = the
   * tooth applies to every adopter at these profiles.
   */
  requiresCapability?: Capability;
  layers: Layer[];
  kind: ToothKind;
  mustRed: MustRed[];
  run: (ctx: ToothContext) => Promise<void>;
}

export type RegistrationErrorCode =
  | "BAD_ID"
  | "DUPLICATE_ID"
  | "NO_PROFILES"
  | "NO_LAYERS"
  | "BASELINE_WITHOUT_FAILURE_CONDITION"
  | "NO_MUST_RED"
  | "MUST_RED_UNANSWERED"
  | "TIER_BOUNDARY";

export class ToothRegistrationError extends Error {
  readonly code: RegistrationErrorCode;

  constructor(code: RegistrationErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ToothRegistrationError";
    this.code = code;
  }
}

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

const registry = new Map<string, ToothSpec>();

export function registerTooth(spec: ToothSpec): void {
  if (!spec.id || !ID_RE.test(spec.id)) {
    throw new ToothRegistrationError(
      "BAD_ID",
      `tooth id ${JSON.stringify(spec.id)} must be non-empty dotted/kebab lower-case`,
    );
  }
  if (registry.has(spec.id)) {
    throw new ToothRegistrationError("DUPLICATE_ID", `tooth ${spec.id} already registered`);
  }
  if (!spec.profiles || spec.profiles.length === 0) {
    throw new ToothRegistrationError("NO_PROFILES", `tooth ${spec.id} declares no profiles`);
  }
  if (!spec.layers || spec.layers.length === 0) {
    throw new ToothRegistrationError("NO_LAYERS", `tooth ${spec.id} declares no layers`);
  }
  if (spec.kind.kind === "baseline" && !spec.kind.failureCondition.trim()) {
    throw new ToothRegistrationError(
      "BASELINE_WITHOUT_FAILURE_CONDITION",
      `tooth ${spec.id} is baseline but states no failure condition (when should it go RED and what replaces it?)`,
    );
  }
  if (!spec.mustRed || spec.mustRed.length === 0) {
    throw new ToothRegistrationError(
      "NO_MUST_RED",
      `tooth ${spec.id} declares no must-red mutations — a check that cannot fail is decoration`,
    );
  }
  for (const mr of spec.mustRed) {
    if (!mr.mutate.trim()) {
      throw new ToothRegistrationError("MUST_RED_UNANSWERED", `tooth ${spec.id}: empty mutation`);
    }
    if (
      mr.caughtOnlyBy !== "this" &&
      (!mr.caughtOnlyBy.alsoCaughtBy.trim() || !mr.caughtOnlyBy.whyStillNeeded.trim())
    ) {
      throw new ToothRegistrationError(
        "MUST_RED_UNANSWERED",
        `tooth ${spec.id}: mutation ${JSON.stringify(mr.mutate)} must answer "who else would catch this?" — either "this" or a justified alsoCaughtBy`,
      );
    }
  }
  for (const profile of spec.profiles) {
    const allowed = PROFILE_LAYERS[profile];
    for (const layer of spec.layers) {
      if (!allowed.has(layer)) {
        throw new ToothRegistrationError(
          "TIER_BOUNDARY",
          `tooth ${spec.id} is tagged profile "${profile}" but exercises layer ${layer}, outside that profile's set`,
        );
      }
    }
  }
  registry.set(spec.id, spec);
}

/**
 * Teeth that run for a profile and a set of opted-in capabilities.
 * Capabilities default to all, so a caller that does not care gets the
 * broadest set rather than silently running less than it thinks.
 */
export function teethFor(
  profile: Profile,
  capabilities: readonly Capability[] = ALL_CAPABILITIES,
): ToothSpec[] {
  return [...registry.values()].filter(
    (t) =>
      t.profiles.includes(profile) &&
      (t.requiresCapability === undefined || capabilities.includes(t.requiresCapability)),
  );
}

export function allTeeth(): ToothSpec[] {
  return [...registry.values()];
}

/**
 * Export consumed by the mutation-runner: every tooth with its declared
 * must-red list (the runner's contract: unmutated baseline must be 0-fail,
 * each declared mutation must turn the owning tooth red).
 */
export function exportForMutationRunner(): Array<{ id: string; mustRed: MustRed[] }> {
  return [...registry.values()].map((t) => ({ id: t.id, mustRed: t.mustRed }));
}

/** Test-only: reset the registry between suites. */
export function clearRegistry(): void {
  registry.clear();
}
