# Frozen TypeScript reference

This is the v0.2 implementation, retained to verify v1 disk/wire interoperability
and to audit behavioral coverage during the Rust migration. Production code and
new development live in `../src`. Nothing here is bundled into a native installer.

Run the old reference in this directory with Node 24+ and pnpm. The original
374-test baseline was run before migration; Rust gates are documented in the
root README. `cargo test --features legacy-interop --test legacy` exercises the
old implementation against the new implementation directly.
