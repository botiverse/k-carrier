import type { BlackBoxTarget } from "../../harness/src/target.ts";

/**
 * cli-tool's black-box target — explicit command declarations (§1.76 ②).
 * REQUIRED: the harness never guesses command names; this file is the
 * adopter's compile-time-checked contract (`satisfies BlackBoxTarget`).
 */
export default {
  version: ["--version"],
  selfUpgrade: ["self", "upgrade"],
} satisfies BlackBoxTarget;
