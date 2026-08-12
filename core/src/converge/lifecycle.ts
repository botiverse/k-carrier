/**
 * host_lifecycle_converged — the lifecycle read-back predicate (design-v1
 * §L3, test-plan M5). Lifted from the supervisor-retirement design.
 *
 * An upgrade that "says it happened" must be mechanically provable. Beyond
 * binary_at_target (the live process), the OS-lifecycle surface must agree:
 * the supervisor/auto-start entry must actually reference what the upgrade
 * installed. Evidence comes from a NAMED SSOT surface the platform adapter
 * declares — a surface that cannot be read back on a real machine may not
 * claim same-source, and a surface NOT on the adapter's allowlist is
 * refused outright (未注册面被引用 ⇒ 拒).
 *
 * PROJECTION BAN: version strings, release metadata and upgrade counts may
 * never satisfy this predicate. The surface value must reference the
 * artifact PATH that was installed — a value derived from metadata (e.g.
 * "I registered version 2.0.0") is not evidence that the OS will actually
 * start that artifact. The evaluator checks the read-back against the
 * expected target PATH; anything else is a refusal.
 */
import { ArtifactError } from "../artifact/errors.ts";
import type { PredicateResult } from "./predicates.ts";

/** A registered (allowlisted) surface with its expected read-back. */
export interface AllowlistedSurface {
  surface: ReadbackSurfaceLike;
  /** What convergence requires the surface to read back (the artifact path). */
  expectedTarget: string;
}

import type { ReadbackSurface } from "./predicates.ts";
type ReadbackSurfaceLike = ReadbackSurface;

export type SurfaceAllowlist = ReadonlyMap<string, AllowlistedSurface>;

/**
 * Build the allowlist from the app's declared surfaces + their expected
 * targets. The allowlist IS the trust boundary: an id not on it cannot be
 * read as evidence.
 */
export function buildSurfaceAllowlist(
  entries: Array<{ surface: ReadbackSurface; expectedTarget: string }>,
): SurfaceAllowlist {
  const map = new Map<string, AllowlistedSurface>();
  for (const entry of entries) {
    if (map.has(entry.surface.id)) {
      throw new Error(`duplicate readback surface id ${entry.surface.id}`);
    }
    map.set(entry.surface.id, entry);
  }
  return map;
}

/** Read an allowlisted surface; an unregistered id is a typed refusal. */
export async function readAllowlisted(
  allowlist: SurfaceAllowlist,
  id: string,
): Promise<{ value: string; source: string }> {
  const entry = allowlist.get(id);
  if (entry === undefined) {
    throw new ArtifactError(
      "UNREGISTERED_SURFACE",
      `readback surface ${JSON.stringify(id)} is not on the adapter's allowlist`,
    );
  }
  return entry.surface.read();
}

/**
 * Evaluate host_lifecycle_converged over every allowlisted surface. All
 * must read back their expected target PATH (projection ban: a metadata
 * string cannot reference a path). Returns the predicate result; `source`
 * names the surfaces that vouched (auditable, not prose).
 */
export async function evaluateLifecycleConvergence(
  allowlist: SurfaceAllowlist,
  observedAtMs: number,
): Promise<PredicateResult> {
  const detail: Record<string, string> = {};
  const sources: string[] = [];
  for (const [id, entry] of allowlist) {
    let value: string;
    try {
      const read = await readAllowlisted(allowlist, id);
      value = read.value;
    } catch (err) {
      return {
        passed: false,
        source: id,
        observedAtMs,
        detail: { error: (err as Error).message },
      };
    }
    detail[id] = value;
    if (!value.includes(entry.expectedTarget)) {
      return {
        passed: false,
        source: id,
        observedAtMs,
        detail: {
          expected: entry.expectedTarget,
          got: value,
          reason: "surface read-back does not reference the installed artifact path",
        },
      };
    }
    sources.push(id);
  }
  return {
    passed: true,
    source: sources.join(","),
    observedAtMs,
    detail,
  };
}
