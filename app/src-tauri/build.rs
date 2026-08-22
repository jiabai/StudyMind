fn main() {
    tauri_build::build();

    // macOS: the swift-bridge crates (screencapturekit -> apple-cf/apple-metal, objc2)
    // link the final binary against the Swift runtime (@rpath/libswift*.dylib).
    // The OS ships that runtime in the dyld shared cache, resolvable at the canonical
    // path /usr/lib/swift — but only if the executable carries LC_RPATH for it.
    // Without this, release builds die at launch with:
    //   "Library not loaded: @rpath/libswiftCore.dylib ... no LC_RPATH's found"
    // (EXC_CRASH/SIGABRT, dyld namespace; see 2026-08-21 crash report).
    // Dev-mode cargo test/check got away with it via DYLD_LIBRARY_PATH=/usr/lib/swift;
    // packaged apps have no such env, hence the crash.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
