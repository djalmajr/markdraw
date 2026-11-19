fn main() {
    tauri_build::build();

    // Windows: `cargo test --lib` produces a test binary that does NOT inherit
    // the SxS manifest `tauri_build` embeds into the app binary (via resource.lib).
    // A static import of `TaskDialogIndirect` (ComCtl32 v6, pulled in via rfd /
    // tauri-plugin-dialog) then fails to load with STATUS_ENTRYPOINT_NOT_FOUND,
    // because the System32 comctl32.dll is v5.82 and lacks it.
    //
    // We can't scope link args to just the lib unit-test binary: `rustc-link-arg-tests`
    // only covers integration tests (tests/), and `rustc-link-arg` also hits the
    // app bin, where a second manifest is a duplicate-resource link error
    // (CVT1100). So the test hooks opt in via ASCIIMARK_EMBED_TEST_MANIFEST — and
    // since `cargo test --lib` does not build the app bin, embedding the manifest
    // for all link invocations under that flag is safe.
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-env-changed=ASCIIMARK_EMBED_TEST_MANIFEST");
        if std::env::var_os("ASCIIMARK_EMBED_TEST_MANIFEST").is_some() {
            let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests.manifest");
            println!("cargo:rerun-if-changed=tests.manifest");
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        }
    }
}
