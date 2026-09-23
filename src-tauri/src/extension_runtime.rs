use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State, WebviewWindow};

struct ManagedProcess {
    child: Child,
    token: String,
    endpoint: String,
    features: Option<RuntimeFeatures>,
    replies: Option<std::sync::mpsc::Receiver<Result<String, std::io::Error>>>,
}
impl Drop for ManagedProcess {
    fn drop(&mut self) {
        if let Some(stdin) = self.child.stdin.as_mut() {
            let _ = stdin.write_all(b"shutdown\n");
        }
        let deadline = Instant::now() + Duration::from_millis(750);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        #[cfg(target_os = "windows")]
        {
            let mut command = Command::new("taskkill");
            hide(&mut command);
            let _ = command
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Clone, Default)]
pub(crate) struct ExtensionRuntimeManager {
    process: Arc<Mutex<Option<ManagedProcess>>>,
}
impl ExtensionRuntimeManager {
    #[cfg(moya_portable)]
    pub(crate) fn change_vault(
        &self,
        prepare: impl FnOnce() -> Result<Option<String>, String>,
        commit: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        // Starting a host and changing its vault use the same lock.
        let mut process = self
            .process
            .lock()
            .map_err(|_| "확장 실행기에 연결하지 못했습니다.")?;
        let key = prepare()?;
        if let Some(running) = process.as_mut() {
            let message = serde_json::json!({"command":"vault", "key":key}).to_string() + "\n";
            let result = (|| -> Result<(), String> {
                running
                    .child
                    .stdin
                    .as_mut()
                    .ok_or("source_vault_unavailable")?
                    .write_all(message.as_bytes())
                    .map_err(|_| "source_vault_unavailable")?;
                let line = running
                    .replies
                    .as_ref()
                    .ok_or("source_vault_unavailable")?
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| "source_vault_unavailable")?
                    .map_err(|_| "source_vault_unavailable")?;
                let response: serde_json::Value =
                    serde_json::from_str(&line).map_err(|_| "source_vault_unavailable")?;
                if response["error"] == "source_vault_busy" {
                    return Err("source_vault_busy".into());
                }
                if response["ok"] != true {
                    return Err("source_vault_unavailable".into());
                }
                Ok(())
            })();
            if let Err(error) = result {
                if error == "source_vault_busy" {
                    return Err("소스 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.".into());
                }
                // An unacknowledged key must never be reused by a later host.
                process.take();
                return Err("보관소를 전환하지 못했습니다. 다시 시도해 주세요.".into());
            }
            if let Some(features) = running.features.as_mut() {
                features.credential_vault = key.is_some();
            }
        }
        commit()
    }
    pub(crate) fn stop_before_exit(&self) {
        if let Ok(mut process) = self.process.lock() {
            process.take();
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ExtensionRuntimeConnection {
    endpoint: String,
    #[serde(default)]
    features: Option<RuntimeFeatures>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFeatures {
    credential_vault: bool,
    mangayomi: bool,
    apk: bool,
}
fn valid_token(token: &str) -> bool {
    (43..=128).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn hide(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}
#[cfg(moya_portable)]
fn credential_key() -> Result<String, String> {
    crate::portable_vault::key_hex()
}
#[cfg(all(not(moya_portable), not(any(target_os = "android", target_os = "ios"))))]
fn credential_key() -> Result<String, String> {
    let entry = keyring::Entry::new("Moya Extension Credentials", "vault-master-v1")
        .map_err(|_| "source_vault_unavailable")?;
    let bytes = match entry.get_secret() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => {
            let mut value = vec![0u8; 32];
            getrandom::getrandom(&mut value).map_err(|_| "source_vault_unavailable")?;
            entry
                .set_secret(&value)
                .map_err(|_| "source_vault_unavailable")?;
            value
        }
        Err(_) => return Err("source_vault_unavailable".into()),
    };
    if bytes.len() != 32 {
        return Err("source_vault_unavailable".into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
#[cfg(all(not(moya_portable), any(target_os = "android", target_os = "ios")))]
fn credential_key() -> Result<String, String> {
    Err("source_vault_unavailable".into())
}
#[tauri::command]
pub(crate) async fn desktop_extension_runtime_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ExtensionRuntimeManager>,
    session_token: String,
) -> Result<ExtensionRuntimeConnection, String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Err("이 기기는 확장 단독 실행을 지원하지 않습니다.".into());
    }
    if !valid_token(&session_token) {
        return Err("invalid_native_token".into());
    }
    let url = window.url().map_err(|_| "native_origin_unavailable")?;
    let origin = if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        "tauri://localhost".to_string()
    } else {
        url.origin().ascii_serialization()
    };
    let directory = if cfg!(debug_assertions) && !cfg!(moya_portable) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("extension-sidecar")
    } else {
        crate::portable::runtime_dir(&app)?.join("extension-sidecar")
    };
    let manager = state.inner().clone();
    let vault_directory = crate::portable::data_dir(&app)?.join("extension-credentials");
    tauri::async_runtime::spawn_blocking(move || {
        let mut process = manager
            .process
            .lock()
            .map_err(|_| "native_runtime_lock_failed")?;
        if let Some(running) = process.as_mut() {
            if running.token == session_token && matches!(running.child.try_wait(), Ok(None)) {
                return Ok(ExtensionRuntimeConnection {
                    endpoint: running.endpoint.clone(),
                    features: running.features.clone(),
                });
            }
        }
        process.take();
        let node = directory.join(if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        });
        let entry = directory.join("native-entry.mjs");
        if !node.is_file() || !entry.is_file() {
            return Err(
                "앱의 확장 실행기가 없습니다. 실행기가 포함된 버전으로 업데이트해 주세요.".into(),
            );
        }
        let mut command = Command::new(node);
        hide(&mut command);
        command
            .arg(entry)
            .current_dir(&directory)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for key in ["SystemRoot", "WINDIR", "TMP", "TEMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let child = command.spawn().map_err(|_| "native_runtime_start_failed")?;
        let mut running = ManagedProcess {
            child,
            token: session_token.clone(),
            endpoint: String::new(),
            features: None,
            replies: None,
        };
        // The protected key travels only over the inherited pipe, never through WebView IPC or command arguments.
        // Before vault creation, public sources can use a session store; saved locked settings never fall back.
        let vault_key = credential_key().ok();
        let input = serde_json::json!({"token":session_token,"origin":origin,"vaultDirectory":vault_directory,"vaultKey":vault_key,"vaultConfigured":crate::portable_vault::desktop_portable_vault_status()?.configured}).to_string() + "\n";
        running
            .child
            .stdin
            .as_mut()
            .ok_or("native_runtime_pipe_failed")?
            .write_all(input.as_bytes())
            .map_err(|_| "native_runtime_pipe_failed")?;
        let stdout = running
            .child
            .stdout
            .take()
            .ok_or("native_runtime_pipe_failed")?;
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match (&mut stdout).take(4096).read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if !line.ends_with('\n') || send.send(Ok(line)).is_err() { break; }
                    }
                    Err(error) => { let _ = send.send(Err(error)); break; }
                }
            }
        });
        let line = receive
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "native_runtime_start_timeout")?
            .map_err(|_| "native_runtime_pipe_failed")?;
        let ready: ExtensionRuntimeConnection =
            serde_json::from_str(&line).map_err(|_| "확장 실행기를 시작하지 못했습니다. 앱을 다시 실행하거나 최신 버전으로 교체해 주세요.")?;
        let parsed: tauri::Url = ready
            .endpoint
            .parse()
            .map_err(|_| "native_runtime_invalid_endpoint")?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.port().is_none()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            return Err("native_runtime_invalid_endpoint".into());
        }
        running.replies = Some(receive);
        running.endpoint = ready.endpoint.clone();
        running.features = ready.features.clone();
        *process = Some(running);
        Ok(ready)
    })
    .await
    .map_err(|_| "native_runtime_start_failed".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_native_session_tokens() {
        assert!(valid_token(&"a".repeat(64)));
        assert!(!valid_token("short"));
        assert!(!valid_token(&"a".repeat(129)));
        assert!(!valid_token(&format!("{}\n", "a".repeat(64))));
    }
}
