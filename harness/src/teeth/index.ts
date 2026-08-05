/**
 * Teeth registration index — importing this module registers every tooth
 * in the harness (the side effect the k-harness runner and CI rely on).
 * Tests import their own modules; this is the single entry for the CLI.
 */
import "./m0.ts";
import "./artifactFactory.ts";
import "./fakeHost.ts";
import "./selfCheck.ts";
import "./examples.ts";
