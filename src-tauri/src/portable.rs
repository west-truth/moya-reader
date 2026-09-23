use std::path::PathBuf;
use tauri::AppHandle;
#[cfg(not(moya_portable))]
use tauri::Manager;

#[cfg(moya_portable)]
#[derive(Clone)]
pub(crate) struct PortableProfile {
    pub(crate) root: PathBuf,
    pub(crate) runtime: PathBuf,
    _lock: std::sync::Arc<std::fs::File>,
}

#[cfg(moya_portable)]
pub(crate) fn prepare() -> Result<PortableProfile, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Cursor, Write};
    use std::sync::OnceLock;

    static PROFILE: OnceLock<Result<PortableProfile, String>> = OnceLock::new();
    PROFILE
        .get_or_init(|| {
            let exe = std::env::current_exe().map_err(|_| "실행 파일 경로를 찾을 수 없습니다.")?;
            let root = exe
                .parent()
                .ok_or("실행 파일 폴더를 찾을 수 없습니다.")?
                .join("MoyaData");
            std::fs::create_dir_all(&root)
                .map_err(|_| "MoyaData 폴더에 쓸 수 없습니다. 쓰기 가능한 폴더에서 실행해 주세요.")?;
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join(".moya-running.lock"))
                .map_err(|_| "MoyaData 폴더를 잠글 수 없습니다.")?;
            if lock.try_lock().is_err() {
                if crate::portable_activation::activate_existing(&root) {
                    return Err("moya_existing_focused".into());
                }
                return Err("이 MoyaData 폴더를 사용하는 Moya가 이미 실행 중입니다.".into());
            }
            let payload = include_bytes!(concat!(env!("OUT_DIR"), "/portable-payload.zip"));
            let digest = format!("{:x}", Sha256::digest(payload));
            let runtime = root.join("runtime").join(&digest[..20]);
            let marker = runtime.join(".moya-payload-sha256");
            let ready = || {
                std::fs::read_to_string(&marker).ok().as_deref() == Some(digest.as_str())
                    && runtime.join("extension-sidecar/node.exe").is_file()
                    && runtime.join("extension-sidecar/native-entry.mjs").is_file()
                    && runtime
                        .join("collector-sidecar/webnovel-metadata-collector.exe")
                        .is_file()
            };
            if !ready() {
                if runtime.exists() {
                    return Err("포터블 실행 파일의 내부 리소스가 손상됐습니다. MoyaData/runtime의 해당 버전을 확인해 주세요.".into());
                }
                let runtime_parent = root.join("runtime");
                std::fs::create_dir_all(&runtime_parent)
                    .map_err(|_| "포터블 실행기 폴더를 만들 수 없습니다.")?;
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "시스템 시각을 읽을 수 없습니다.")?
                    .as_nanos();
                let stage = runtime_parent.join(format!(".extract-{}-{nonce}", std::process::id()));
                std::fs::create_dir(&stage)
                    .map_err(|_| "포터블 실행기 임시 폴더를 만들 수 없습니다.")?;
                let extracted = (|| -> Result<(), String> {
                    let mut archive = zip::ZipArchive::new(Cursor::new(payload))
                        .map_err(|_| "포터블 실행 파일의 내부 압축 파일을 읽을 수 없습니다.")?;
                    if archive.len() > 20_000 {
                        return Err("포터블 실행기 파일 수가 허용 범위를 넘었습니다.".into());
                    }
                    let mut total: u64 = 0;
                    for index in 0..archive.len() {
                        let mut file = archive.by_index(index)
                            .map_err(|_| "포터블 실행기 파일을 읽을 수 없습니다.")?;
                        let relative = file.enclosed_name()
                            .ok_or("포터블 실행기 파일 경로가 올바르지 않습니다.")?;
                        if !relative.starts_with("extension-sidecar")
                            && !relative.starts_with("collector-sidecar")
                            && relative != std::path::Path::new("webview2-fixed.cab")
                        {
                            return Err("포터블 실행기에 예상하지 못한 파일이 있습니다.".into());
                        }
                        total = total.saturating_add(file.size());
                        if total > 2 * 1024 * 1024 * 1024 {
                            return Err("포터블 실행기 크기가 허용 범위를 넘었습니다.".into());
                        }
                        // The CAB stays compressed until a PC actually needs the fallback WebView2 runtime.
                        if relative == std::path::Path::new("webview2-fixed.cab") {
                            continue;
                        }
                        let target = stage.join(relative);
                        if file.is_dir() {
                            std::fs::create_dir_all(&target)
                                .map_err(|_| "포터블 실행기 폴더를 만들 수 없습니다.")?;
                            continue;
                        }
                        std::fs::create_dir_all(target.parent().ok_or("잘못된 실행기 경로")?)
                            .map_err(|_| "포터블 실행기 폴더를 만들 수 없습니다.")?;
                        let mut output = std::fs::File::create(&target)
                            .map_err(|_| "포터블 실행기를 디스크에 쓸 수 없습니다.")?;
                        std::io::copy(&mut file, &mut output)
                            .map_err(|_| "포터블 실행기를 디스크에 쓸 수 없습니다.")?;
                        output.flush().map_err(|_| "포터블 실행기 파일 기록에 실패했습니다.")?;
                    }
                    if !stage.join("extension-sidecar/node.exe").is_file()
                        || !stage.join("extension-sidecar/native-entry.mjs").is_file()
                        || !stage.join("collector-sidecar/webnovel-metadata-collector.exe").is_file()
                    {
                        return Err("포터블 실행기에 필요한 파일이 빠졌습니다.".into());
                    }
                    std::fs::write(stage.join(".moya-payload-sha256"), &digest)
                        .map_err(|_| "포터블 실행기 검증 정보를 기록할 수 없습니다.")?;
                    std::fs::rename(&stage, &runtime)
                        .map_err(|_| "포터블 실행기 설치를 완료할 수 없습니다.")?;
                    Ok(())
                })();
                if extracted.is_err() {
                    // Only this process's private staging directory is removed.
                    let _ = std::fs::remove_dir_all(&stage);
                }
                extracted?;
            }
            Ok(PortableProfile { root, runtime, _lock: std::sync::Arc::new(lock) })
        })
        .clone()
}

#[cfg(all(moya_portable, target_os = "windows"))]
fn installed_webview2() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    use winreg::RegKey;

    const CLIENT: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    [
        (HKEY_CURRENT_USER, KEY_READ),
        (HKEY_CURRENT_USER, KEY_READ | KEY_WOW64_32KEY),
        (HKEY_LOCAL_MACHINE, KEY_READ),
        (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_32KEY),
    ]
    .into_iter()
    .any(|(root, flags)| {
        RegKey::predef(root)
            .open_subkey_with_flags(CLIENT, flags)
            .ok()
            .and_then(|key| key.get_value::<String, _>("pv").ok())
            .is_some_and(|version| !version.is_empty() && version != "0.0.0.0")
    })
}

#[cfg(all(moya_portable, target_os = "windows"))]
pub(crate) fn ensure_webview2() -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::{Cursor, Read, Write};
    use std::os::windows::process::CommandExt;

    if installed_webview2() {
        return Ok(());
    }
    let profile = prepare()?;
    let fixed = profile.runtime.join("webview2-fixed");
    let browser = fixed.join("msedgewebview2.exe");
    if !browser.is_file() {
        if fixed.exists() {
            return Err("포터블 WebView2 실행기 폴더가 손상됐습니다.".into());
        }
        if matches!(fs2::available_space(&profile.runtime), Ok(free) if free < 1_200_000_000) {
            return Err("WebView2 실행기를 풀 공간이 부족합니다. MoyaData가 있는 드라이브에 1.2GB 이상 남겨 주세요.".into());
        }
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "시스템 시각을 읽을 수 없습니다.")?
            .as_nanos();
        let stage = profile
            .runtime
            .join(format!(".webview2-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&stage).map_err(|_| "WebView2 임시 폴더를 만들 수 없습니다.")?;
        let result = (|| -> Result<(), String> {
            let payload = include_bytes!(concat!(env!("OUT_DIR"), "/portable-payload.zip"));
            let mut archive = zip::ZipArchive::new(Cursor::new(payload))
                .map_err(|_| "포터블 실행 파일을 읽을 수 없습니다.")?;
            let mut cab = archive
                .by_name("webview2-fixed.cab")
                .map_err(|_| "포터블 EXE에 WebView2 실행기가 없습니다.")?;
            if cab.size() != 308_509_880 {
                return Err("포터블 WebView2 실행기 크기가 올바르지 않습니다.".into());
            }
            let cab_path = stage.join("webview2-fixed.cab");
            let mut output = std::fs::File::create(&cab_path)
                .map_err(|_| "WebView2 실행기를 디스크에 쓸 수 없습니다.")?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 1024 * 1024];
            loop {
                let read = cab
                    .read(&mut buffer)
                    .map_err(|_| "WebView2 실행기를 읽을 수 없습니다.")?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
                output
                    .write_all(&buffer[..read])
                    .map_err(|_| "WebView2 실행기를 디스크에 쓸 수 없습니다.")?;
            }
            output
                .sync_all()
                .map_err(|_| "WebView2 실행기를 저장하지 못했습니다.")?;
            if format!("{:x}", hasher.finalize())
                != "11e8240cb0bc56dcd3e4498907203c251346f65107fe35a3a13e152c7d51c79e"
            {
                return Err("포터블 WebView2 실행기 해시가 올바르지 않습니다.".into());
            }
            let expanded = stage.join("expanded");
            std::fs::create_dir(&expanded).map_err(|_| "WebView2 임시 폴더를 만들 수 없습니다.")?;
            let success = std::process::Command::new("expand.exe")
                .arg("-F:*")
                .arg(&cab_path)
                .arg(&expanded)
                .creation_flags(0x08000000)
                .status()
                .map_err(|_| "Windows WebView2 압축 해제기를 시작하지 못했습니다.")?
                .success();
            if !success {
                return Err(
                    "WebView2 실행기 압축 해제에 실패했습니다. 저장 공간을 확인해 주세요.".into(),
                );
            }
            let unpacked =
                expanded.join("Microsoft.WebView2.FixedVersionRuntime.153.0.4234.48.x64");
            if !unpacked.join("msedgewebview2.exe").is_file() {
                return Err("WebView2 실행기에 필요한 파일이 빠졌습니다.".into());
            }
            std::fs::rename(unpacked, &fixed)
                .map_err(|_| "WebView2 실행기 준비를 완료하지 못했습니다.")?;
            Ok(())
        })();
        // Only this process's private staging directory is removed.
        let _ = std::fs::remove_dir_all(&stage);
        result?;
    }
    std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", fixed);
    Ok(())
}

pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(moya_portable)]
    {
        let _ = app;
        Ok(prepare()?.root.join("data"))
    }
    #[cfg(not(moya_portable))]
    app.path()
        .app_data_dir()
        .map_err(|_| "native_storage_unavailable".into())
}

pub(crate) fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(moya_portable)]
    {
        let _ = app;
        Ok(prepare()?.root.join("cache"))
    }
    #[cfg(not(moya_portable))]
    app.path()
        .app_cache_dir()
        .map_err(|_| "native_cache_unavailable".into())
}

pub(crate) fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(moya_portable)]
    {
        let _ = app;
        Ok(prepare()?.runtime)
    }
    #[cfg(not(moya_portable))]
    app.path()
        .resource_dir()
        .map_err(|_| "native_resources_unavailable".into())
}

#[cfg(all(moya_portable, target_os = "windows"))]
pub(crate) fn show_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            title: *const u16,
            kind: u32,
        ) -> i32;
    }
    let text: Vec<u16> = std::ffi::OsStr::new(message)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let title: Vec<u16> = std::ffi::OsStr::new("Moya")
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
}
