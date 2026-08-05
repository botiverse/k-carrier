/**
 * ReleaseSource — where releases come from, and what this install should be on.
 *
 * This is the ONLY place in K where version *semantics* live. Everywhere else
 * (engine, journal, slots, predicates, invariants) a version is an opaque
 * string compared with `===`. That boundary is deliberate:
 *
 *   - "which version is latest" requires a version ORDER, and an order
 *     requires a versioning SCHEME (semver? dates? build numbers?). Choosing
 *     it for you would be K deciding your product's versioning.
 *   - anti-rollback has the same dependency, so it belongs here too.
 *
 * Two methods, because they answer two different QUESTIONS (not two steps of
 * one operation):
 *   checkForUpdate — policy: should I upgrade, and to what?
 *   fetchRelease   — named:  give me exactly this version
 *
 * Channels ("stable", "nightly", "lts-2024") are not a K concept at all: they
 * live inside your implementation of this interface. So does long-term
 * pinning — a source that always returns the same version IS a pin.
 */

export interface ReleaseContext {
  /** Version currently installed in the stable slot. */
  currentVersion: string;
  /** Manifest target key for this machine, e.g. "linux-x64". */
  platformKey: string;
}

/** Everything K needs to fetch and verify one release's bytes. */
export interface Release {
  version: string;
  url: string;
  sha256: string;
  size: number;
  /**
   * Signature material for this artifact. A digest proves the bytes did not
   * corrupt in transit; it cannot prove WHO produced them, because it comes
   * from the same place they do. Sources that genuinely have no signing story
   * set `unsigned: true` and K records that in status rather than pretending
   * the artifact was verified.
   */
  signature?: {
    signingKeyPem: string;
    signingKeySignatureB64: string;
    artifactSignatureB64: string;
  };
  /** Explicit opt-out, visible in code and in status. Never a silent default. */
  unsigned?: boolean;
}

export interface ReleaseSource {
  /**
   * Policy question: what should this install upgrade to, if anything?
   * `null` means "nothing to do" — already current by YOUR definition of
   * current. Drives `upgrader.upgrade()` (CLI self-upgrade, background checks).
   */
  checkForUpdate(ctx: ReleaseContext): Promise<Release | null>;

  /**
   * Named question: give me exactly this version.
   * Drives `upgrader.upgradeTo(version)` — a user choosing a version, or a
   * server pushing "go to 1.2.3". This is also the sanctioned DOWNGRADE path:
   * downgrade is always explicit, never automatic.
   */
  fetchRelease(version: string, ctx: ReleaseContext): Promise<Release>;
}
