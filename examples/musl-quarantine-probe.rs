//! Link probe: forces the quarantine path (including its rename) into the
//! linked binary. Without a probe like this, dead-code elimination can drop
//! `rename_exclusive` from every shipped bin, so a musl-incompatible symbol
//! would link "green" while a real consumer (the installer) fails.
fn main() {
    let source = std::path::Path::new("/nonexistent-source");
    let destination = std::path::Path::new("/nonexistent-destination");
    let outcome = k_carrier::quarantine::quarantine_state(source, destination, 0, false, None);
    println!("{outcome:?}");
}
