use serde::Serialize;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const SESSION_TOKEN_MIN_LENGTH: usize = 43;
const SESSION_TOKEN_MAX_LENGTH: usize = 128;
const STARTUP_ATTEMPTS: usize = 160;
const STARTUP_RETRY_DELAY: Duration = Duration::from_millis(50);

struct ManagedCollectorProcess {
    child: Child,
    endpoint: String,
    session_token: String,
}

impl ManagedCollectorProcess {
    fn stop(&mut self) {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = Command::new("taskkill")
                .arg("/PID")
                .arg(self.child.id().to_string())
                .arg("/T")
                .arg("/F")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ManagedCollectorProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Default)]
pub(crate) struct MetadataCollectorManager {
    process: Arc<Mutex<Option<ManagedCollectorProcess>>>,
}

impl MetadataCollectorManager {
    pub(crate) fn stop_before_exit(&self) {
        if let Ok(mut process) = self.process.try_lock() {
            if let Some(mut running) = process.take() {
                running.stop();
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedMetadataCollectorConnection {
    endpoint: String,
}

fn validate_session_token(value: &str) -> Result<(), String> {
    if !(SESSION_TOKEN_MIN_LENGTH..=SESSION_TOKEN_MAX_LENGTH).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Metadata collector session token is invalid".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn hide_process_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_process_window(_: &mut Command) {}

#[cfg(target_os = "windows")]
fn bundled_binary_name() -> &'static str {
    "webnovel-metadata-collector.exe"
}

#[cfg(not(target_os = "windows"))]
fn bundled_binary_name() -> &'static str {
    "webnovel-metadata-collector"
}

fn collector_command(app: &AppHandle, port: u16) -> Result<Command, String> {
    let mut command = if cfg!(debug_assertions) {
        let service_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Metadata collector source directory is unavailable".to_string())?
            .join("services")
            .join("webnovel-metadata-collector");
        let python =
            std::env::var("MOYA_COLLECTOR_PYTHON").unwrap_or_else(|_| "python".to_string());
        let mut command = Command::new(python);
        command
            .current_dir(service_dir)
            .arg("-m")
            .arg("app.sidecar");
        command
    } else {
        let executable = app
            .path()
            .resource_dir()
            .map_err(|_| "Metadata collector resource directory is unavailable".to_string())?
            .join("collector-sidecar")
            .join(bundled_binary_name());
        if !executable.is_file() {
            return Err("Bundled metadata collector is missing".to_string());
        }
        Command::new(executable)
    };
    command
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_process_window(&mut command);
    Ok(command)
}

async fn stop_locked(process: &mut Option<ManagedCollectorProcess>) {
    if let Some(mut running) = process.take() {
        running.stop();
    }
}

#[tauri::command]
pub(crate) async fn desktop_metadata_collector_start(
    app: AppHandle,
    state: State<'_, MetadataCollectorManager>,
    session_token: String,
) -> Result<ManagedMetadataCollectorConnection, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, state, session_token);
        return Err("Bundled metadata collector is unavailable on mobile".to_string());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        validate_session_token(&session_token)?;
        let mut process = state.process.lock().await;
        if let Some(running) = process.as_mut() {
            let alive = running
                .child
                .try_wait()
                .map_err(|_| "Metadata collector state could not be read".to_string())?
                .is_none();
            if alive && running.session_token == session_token {
                return Ok(ManagedMetadataCollectorConnection {
                    endpoint: running.endpoint.clone(),
                });
            }
            stop_locked(&mut process).await;
        }

        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "A loopback port for the metadata collector is unavailable".to_string())?;
        let port = listener
            .local_addr()
            .map_err(|_| "The metadata collector loopback port is invalid".to_string())?
            .port();
        drop(listener);

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "Metadata collector app data directory is unavailable".to_string())?
            .join("metadata-collector");
        std::fs::create_dir_all(&data_dir).map_err(|_| {
            "Metadata collector app data directory could not be created".to_string()
        })?;
        let mut command = collector_command(&app, port)?;
        command
            .env("MOYA_COLLECTOR_SESSION_TOKEN", &session_token)
            .env("MOYA_COLLECTOR_DATA_DIR", &data_dir);
        let mut child = command
            .spawn()
            .map_err(|_| "Bundled metadata collector could not be started".to_string())?;

        let endpoint = format!("http://127.0.0.1:{port}");
        for _ in 0..STARTUP_ATTEMPTS {
            if child
                .try_wait()
                .map_err(|_| "Metadata collector startup state could not be read".to_string())?
                .is_some()
            {
                return Err("Bundled metadata collector stopped during startup".to_string());
            }
            if std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_ok() {
                *process = Some(ManagedCollectorProcess {
                    child,
                    endpoint: endpoint.clone(),
                    session_token,
                });
                return Ok(ManagedMetadataCollectorConnection { endpoint });
            }
            tokio::time::sleep(STARTUP_RETRY_DELAY).await;
        }
        let _ = child.kill();
        let _ = child.wait();
        Err("Bundled metadata collector did not become ready".to_string())
    }
}

#[tauri::command]
pub(crate) async fn desktop_metadata_collector_stop(
    state: State<'_, MetadataCollectorManager>,
) -> Result<(), String> {
    let mut process = state.process.lock().await;
    stop_locked(&mut process).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_session_token;

    #[test]
    fn accepts_only_bounded_base64url_style_session_tokens() {
        assert!(validate_session_token("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG_HIJK").is_ok());
        assert!(validate_session_token("short").is_err());
        assert!(
            validate_session_token("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG+HIJK").is_err()
        );
    }
}
