//! Private parent/child transport for the shared self-host server.
//! The token never goes into a URL, persistent WebView storage, or application logs.
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    process::{ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SharingInterface {
    name: String,
    address: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerStatus {
    phase: String,
    running: bool,
    url: Option<String>,
    auth_token: Option<String>,
    error: Option<String>,
    interfaces: Vec<SharingInterface>,
    sharing_url: Option<String>,
    sharing_error: Option<String>,
}

#[derive(Default)]
struct ManagedState {
    status: ServerStatus,
    input: Option<ChildStdin>,
    exit_after_stop: bool,
}

#[derive(Clone, Default)]
pub(crate) struct EmbeddedServerManager(Arc<Mutex<ManagedState>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerMessage {
    event: String,
    phase: Option<String>,
    url: Option<String>,
    auth_token: Option<String>,
    message: Option<String>,
    interfaces: Option<Vec<SharingInterface>>,
    sharing_url: Option<String>,
    sharing_error: Option<String>,
}

fn require_local_window(window: &WebviewWindow) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|_| "앱 창의 주소를 확인하지 못했습니다.")?;
    if window.label() == "main"
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none())
            || (cfg!(debug_assertions)
                && url.origin().ascii_serialization() == "http://127.0.0.1:1421"))
    {
        Ok(())
    } else {
        Err("내장 서버는 모야 앱 창에서만 제어할 수 있습니다.".into())
    }
}

impl EmbeddedServerManager {
    pub(crate) fn running(&self) -> bool {
        self.0
            .lock()
            .map(|state| state.status.running)
            .unwrap_or(true)
    }

    fn start(&self, app: &AppHandle) -> Result<ServerStatus, String> {
        if cfg!(mobile) {
            return Err("이 기기에서는 내장 서버를 실행할 수 없습니다.".into());
        }
        let mut state = self.0.lock().map_err(|_| "서버 상태를 읽지 못했습니다.")?;
        if state.status.running {
            return Ok(state.status.clone());
        }
        let runtime = if cfg!(debug_assertions) {
            std::env::var_os("MOYA_EMBEDDED_RUNTIME").map(std::path::PathBuf::from)
        } else {
            None
        }
        .unwrap_or(crate::portable::runtime_dir(app)?.join("embedded-server/runtime.json"));
        let directory = runtime.parent().ok_or("서버 실행 폴더가 없습니다.")?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&runtime).map_err(|_| {
                "동봉된 서버 파일을 찾지 못했습니다. 모야 설치 파일을 확인해 주세요."
            })?)
            .map_err(|_| "서버 실행 구성이 손상되었습니다.")?;
        let node = directory.join(
            manifest["node"]
                .as_str()
                .ok_or("서버 실행 파일이 없습니다.")?,
        );
        let profile = if cfg!(debug_assertions) {
            std::env::var_os("MOYA_EMBEDDED_PROFILE").map(std::path::PathBuf::from)
        } else {
            None
        }
        .unwrap_or(crate::portable::data_dir(app)?.join("embedded-server"));
        std::fs::create_dir_all(&profile).map_err(|_| "서버 데이터 폴더를 만들지 못했습니다.")?;
        let mut log_options = std::fs::OpenOptions::new();
        log_options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            log_options.mode(0o600);
        }
        let error_log = log_options
            .open(profile.join("launcher.log"))
            .map_err(|_| "서버 실행 로그를 열지 못했습니다.")?;
        let mut command = Command::new(node);
        command
            .arg(directory.join("embedded-server.mjs"))
            .arg(&runtime)
            .arg(&profile)
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(error_log));
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|_| "내장 서버 실행에 실패했습니다.")?;
        state.input = child.stdin.take();
        state.exit_after_stop = false;
        state.status = ServerStatus {
            phase: "preparing".into(),
            running: true,
            ..Default::default()
        };
        let output = child
            .stdout
            .take()
            .ok_or("서버 응답 채널을 열지 못했습니다.")?;
        let manager = self.clone();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<ServerMessage>(&line) else {
                    continue;
                };
                let Ok(mut state) = manager.0.lock() else {
                    break;
                };
                // A shutdown requested during startup must not be overwritten by late readiness.
                if state.status.phase == "stopping" {
                    continue;
                }
                match message.event.as_str() {
                    "phase" => {
                        state.status.phase = message.phase.unwrap_or_else(|| "preparing".into())
                    }
                    "ready" => {
                        if !message
                            .url
                            .as_deref()
                            .is_some_and(|url| url.starts_with("http://127.0.0.1:"))
                            || !message.auth_token.as_deref().is_some_and(|token| {
                                token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
                            })
                        {
                            state.status.error = Some("서버 연결 정보가 올바르지 않습니다.".into());
                            continue;
                        }
                        state.status.phase = "ready".into();
                        state.status.interfaces = message.interfaces.unwrap_or_default();
                        state.status.url = message.url;
                        state.status.auth_token = message.auth_token;
                    }
                    "sharing" => {
                        state.status.sharing_url = message.sharing_url;
                        state.status.sharing_error = message.sharing_error;
                    }
                    "error" => state.status.error = message.message,
                    _ => {}
                }
            }
        });
        let manager = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let result = child.wait();
            let _ = reader.join();
            let Ok(mut state) = manager.0.lock() else {
                return;
            };
            let success = result.is_ok_and(|status| status.success());
            state.input = None;
            state.status.running = false;
            state.status.url = None;
            state.status.auth_token = None;
            state.status.phase = if success { "stopped" } else { "failed" }.into();
            if !success && state.status.error.is_none() {
                state.status.error =
                    Some("서버가 중단되었습니다. 서버 데이터 폴더의 로그를 확인해 주세요.".into());
            }
            let exit = success && state.exit_after_stop;
            drop(state);
            if exit {
                app.exit(0);
            }
        });
        Ok(state.status.clone())
    }

    pub(crate) fn stop(&self, app: &AppHandle) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "서버 상태를 읽지 못했습니다.")?;
        if !state.status.running {
            drop(state);
            app.exit(0);
            return Ok(());
        }
        if state.status.phase == "stopping" {
            return Ok(());
        }
        state
            .input
            .as_mut()
            .ok_or("서버 종료 채널이 없습니다.")?
            .write_all(b"shutdown\n")
            .map_err(|_| "서버 종료 요청을 전달하지 못했습니다.")?;
        state.exit_after_stop = true;
        state.status.phase = "stopping".into();
        state.status.auth_token = None;
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn desktop_embedded_server_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, EmbeddedServerManager>,
) -> Result<ServerStatus, String> {
    require_local_window(&window)?;
    state.start(&app)
}

#[tauri::command]
pub(crate) fn desktop_embedded_server_status(
    window: WebviewWindow,
    state: State<'_, EmbeddedServerManager>,
) -> Result<ServerStatus, String> {
    require_local_window(&window)?;
    state
        .0
        .lock()
        .map(|state| state.status.clone())
        .map_err(|_| "서버 상태를 읽지 못했습니다.".into())
}

#[tauri::command]
pub(crate) fn desktop_embedded_server_close(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, EmbeddedServerManager>,
    keep_running: bool,
) -> Result<(), String> {
    require_local_window(&window)?;
    if keep_running {
        #[cfg(desktop)]
        if app.tray_by_id("embedded-server").is_none() {
            return Err("트레이를 사용할 수 없습니다. 서버를 종료하거나 창을 열어 두세요.".into());
        }
        window.hide().map_err(|_| "창을 숨기지 못했습니다.".into())
    } else {
        state.stop(&app)
    }
}

#[tauri::command]
pub(crate) fn desktop_embedded_server_share(
    window: WebviewWindow,
    state: State<'_, EmbeddedServerManager>,
    host: Option<String>,
) -> Result<(), String> {
    require_local_window(&window)?;
    let mut state = state.0.lock().map_err(|_| "서버 상태를 읽지 못했습니다.")?;
    if state.status.phase != "ready" {
        return Err("서버가 준비되지 않았습니다.".into());
    }
    let line = serde_json::to_string(&serde_json::json!({ "command": "sharing", "host": host }))
        .map_err(|_| "접속 설정을 전달하지 못했습니다.")?
        + "\n";
    state
        .input
        .as_mut()
        .ok_or("서버 연결이 끊겼습니다.")?
        .write_all(line.as_bytes())
        .map_err(|_| "접속 설정을 전달하지 못했습니다.")?;
    state.status.sharing_error = None;
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let open = MenuItem::with_id(app, "open", "모야 열기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "서버와 모야 종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("embedded-server")
        .tooltip("모야 서재 서버")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                if event.id.as_ref() == "quit" {
                    let _ = window.emit("embedded-server-close-requested", ());
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
