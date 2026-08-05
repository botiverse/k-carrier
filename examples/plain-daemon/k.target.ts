import type { BlackBoxTarget } from "../../harness/src/target.ts";

/**
 * plain-daemon's black-box target — explicit command declarations (§1.76
 * ②). REQUIRED: the harness never guesses command names.
 */
export default {
  version: ["--version"],
  selfUpgrade: ["self", "upgrade"],
} satisfies BlackBoxTarget;
