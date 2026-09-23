fn main() {
    println!("cargo:rustc-check-cfg=cfg(moya_portable)");
    println!("cargo:rerun-if-env-changed=MOYA_PORTABLE_BUILD");
    println!("cargo:rerun-if-changed=portable-payload.zip");
    if std::env::var("MOYA_PORTABLE_BUILD").as_deref() == Ok("1") {
        let payload = std::path::Path::new("portable-payload.zip");
        if !payload.is_file() {
            panic!("portable payload missing; run the portable Windows build command");
        }
        let bytes = std::fs::read(payload).expect("cannot read portable payload");
        if bytes.len() < 1024 {
            panic!("portable payload is empty");
        }
        let output =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR missing"));
        std::fs::write(output.join("portable-payload.zip"), bytes)
            .expect("cannot stage portable payload");
        println!("cargo:rustc-cfg=moya_portable");
    }
    println!("cargo:rerun-if-env-changed=MOYA_GOOGLE_DESKTOP_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=MOYA_GOOGLE_DESKTOP_CLIENT_SECRET");
    tauri_build::build()
}
