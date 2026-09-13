use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewWindow};

struct ManagedProcess {
    child: Child,
    token: String,
    endpoint: String,
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
    pub(crate) fn stop_before_exit(&self) {
        if let Ok(mut process) = self.process.lock() {
            process.take();
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ExtensionRuntimeConnection {
    endpoint: String,
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
#[cfg(not(any(target_os = "android", target_os = "ios")))]
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
#[cfg(any(target_os = "android", target_os = "ios"))]
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
    let directory = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("extension-sidecar")
    } else {
        app.path()
            .resource_dir()
            .map_err(|_| "native_resources_unavailable")?
            .join("extension-sidecar")
    };
    let manager = state.inner().clone();
    let vault_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "native_storage_unavailable")?
        .join("extension-credentials");
    tauri::async_runtime::spawn_blocking(move || {
        let mut process = manager
            .process
            .lock()
            .map_err(|_| "native_runtime_lock_failed")?;
        if let Some(running) = process.as_mut() {
            if running.token == session_token && matches!(running.child.try_wait(), Ok(None)) {
                return Ok(ExtensionRuntimeConnection {
                    endpoint: running.endpoint.clone(),
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
        };
        // The protected key travels only over the inherited pipe, never through WebView IPC or command arguments.
        // A locked credential store does not prevent unauthenticated sources from running.
        let vault_key = credential_key().ok();
        let input = serde_json::json!({"token":session_token,"origin":origin,"vaultDirectory":vault_directory,"vaultKey":vault_key}).to_string() + "\n";
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
            let mut line = String::new();
            let result = BufReader::new(stdout.take(1024))
                .read_line(&mut line)
                .map(|_| line);
            let _ = send.send(result);
        });
        let line = receive
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "native_runtime_start_timeout")?
            .map_err(|_| "native_runtime_pipe_failed")?;
        let ready: ExtensionRuntimeConnection =
            serde_json::from_str(&line).map_err(|_| "native_runtime_invalid_ready")?;
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
        running.endpoint = ready.endpoint.clone();
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
