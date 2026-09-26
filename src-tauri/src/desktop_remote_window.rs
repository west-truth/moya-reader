use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "remote-server";
const WEBVIEW_COMPATIBILITY_MARKER: &str = "name=\"moya-desktop-webview\" content=\"browser-v1\"";

#[derive(Debug, serde::Serialize)]
pub(crate) struct ConnectionFailure {
    message: String,
    stage: &'static str,
    code: &'static str,
    detail: String,
}
impl ConnectionFailure {
    fn new(
        stage: &'static str,
        code: &'static str,
        message: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            code,
            message: message.into(),
            detail: detail.into(),
        }
    }
}
impl From<String> for ConnectionFailure {
    fn from(message: String) -> Self {
        Self::new("창 열기", "window_error", message, "")
    }
}
impl From<&str> for ConnectionFailure {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}
fn request_failure(stage: &'static str, error: reqwest::Error) -> ConnectionFailure {
    use std::error::Error;
    let timeout = error.is_timeout();
    let error = error.without_url();
    let mut details = vec![error.to_string()];
    let mut cause = error.source();
    for _ in 0..4 {
        let Some(current) = cause else {
            break;
        };
        details.push(current.to_string());
        cause = current.source();
    }
    // Only transport errors, never response bodies, account data or headers.
    let detail: String = details.join(" → ").chars().take(1024).collect();
    let lower = detail.to_ascii_lowercase();
    let (code, message) = if timeout {
        (
            "request_timeout",
            "서버 응답 시간이 초과되었습니다. 서버 주소와 네트워크 연결을 확인해 주세요.",
        )
    } else if lower.contains("certificate") || lower.contains("cert") || lower.contains("tls") {
        (
            "tls_error",
            "서버의 보안 연결을 확인하지 못했습니다. HTTPS 인증서를 확인해 주세요.",
        )
    } else {
        (
            "request_failed",
            "서버에 연결하지 못했습니다. 서버 실행 상태와 주소를 확인해 주세요.",
        )
    };
    ConnectionFailure::new(stage, code, message, detail)
}

async fn require_browser_frontend(
    client: &reqwest::Client,
    url: &tauri::Url,
) -> Result<(), ConnectionFailure> {
    const INCOMPATIBLE: &str = "이 서버의 웹 화면은 앱 내 접속을 지원하지 않습니다. 서버를 업데이트하거나 일반 브라우저에서 접속해 주세요.";
    let mut response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| request_failure("웹 화면 확인", error))?;
    if !response.status().is_success() {
        return Err(ConnectionFailure::new(
            "웹 화면 확인",
            "http_status",
            "서버 웹 화면을 읽지 못했습니다.",
            format!("GET / → HTTP {}", response.status().as_u16()),
        ));
    }
    // Check the served frontend, not the API version: older pages treat Tauri's
    // injected, non-configurable globals as permission to invoke native commands.
    // The small bundled index declares that it handles external WebViews as web.
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| request_failure("웹 화면 읽기", error))?
    {
        if bytes.len() + chunk.len() > 64 * 1024 {
            return Err(ConnectionFailure::new(
                "웹 화면 확인",
                "frontend_too_large",
                "서버 웹 화면의 크기가 확인 한도를 초과했습니다.",
                "최대 64 KiB",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !String::from_utf8_lossy(&bytes).contains(WEBVIEW_COMPATIBILITY_MARKER) {
        return Err(ConnectionFailure::new(
            "웹 화면 호환성",
            "frontend_incompatible",
            INCOMPATIBLE,
            "로그인 API 확인 성공. 웹 화면에 moya-desktop-webview=browser-v1 표식이 없습니다.",
        ));
    }
    Ok(())
}

fn is_local_http_host(host: &str) -> bool {
    use std::net::IpAddr;

    let host = host.trim_start_matches('[').trim_end_matches(']');
    let domain = host.to_ascii_lowercase();
    if domain == "localhost"
        || domain.ends_with(".localhost")
        || domain.ends_with(".local")
        || domain.ends_with(".lan")
        || domain.ends_with(".home.arpa")
        || (!domain.contains('.') && !domain.contains(':'))
    {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            let octets = address.octets();
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        Ok(IpAddr::V6(address)) => {
            let first = address.segments()[0];
            address.is_loopback() || (first & 0xfe00 == 0xfc00) || (first & 0xffc0 == 0xfe80)
        }
        Err(_) => false,
    }
}

fn remote_origin(input: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(input.trim()).map_err(|_| "서버 주소를 확인해 주세요.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(
            "서버의 첫 화면 주소를 입력해 주세요. 계정 정보와 /api 경로는 넣지 않습니다.".into(),
        );
    }
    if url.scheme() == "http" && !is_local_http_host(url.host_str().unwrap_or_default()) {
        return Err("공개 서버 주소에는 HTTPS를 사용해 주세요. HTTP는 로컬·LAN·Tailscale 주소만 허용합니다.".into());
    }
    let mut origin = url;
    origin.set_path("/");
    Ok(origin)
}

/// Explicit fallback for older self-host frontends. Keep credentials and native
/// IPC out of the external page; reuse the system browser used by OAuth.
#[tauri::command]
pub(crate) async fn desktop_remote_server_open_browser(
    window: WebviewWindow,
    address: String,
) -> Result<(), String> {
    crate::embedded_server::require_local_window(&window)?;
    let url = remote_origin(&address)?;
    crate::desktop_oauth::open_system_browser(url.as_str())
}

#[tauri::command]
pub(crate) async fn desktop_remote_server_open(
    app: AppHandle,
    window: WebviewWindow,
    address: String,
) -> Result<(), ConnectionFailure> {
    crate::embedded_server::require_local_window(&window)?;
    let url = remote_origin(&address)
        .map_err(|message| ConnectionFailure::new("주소 확인", "invalid_address", message, ""))?;
    let status_url = url
        .join("api/auth/status")
        .map_err(|_| "서버 주소를 확인해 주세요.")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "서버 연결을 준비하지 못했습니다.")?;
    let response = client
        .get(status_url)
        .send()
        .await
        .map_err(|error| request_failure("로그인 API 연결", error))?;
    let status_code = response.status().as_u16();
    if !response.status().is_success() {
        return Err(ConnectionFailure::new(
            "로그인 API 응답",
            "http_status",
            "서버의 로그인 API를 확인하지 못했습니다. 모야 self-host 주소인지 확인해 주세요.",
            format!("GET /api/auth/status → HTTP {status_code}"),
        ));
    }
    let status: serde_json::Value = response.json().await.map_err(|error| {
        if error.is_timeout() || error.is_body() {
            return request_failure("로그인 API 응답 읽기", error);
        }
        ConnectionFailure::new(
            "로그인 API 응답",
            "invalid_json",
            "서버의 로그인 응답 형식이 맞지 않습니다.",
            format!("GET /api/auth/status → HTTP {status_code}; JSON 응답을 읽을 수 없음"),
        )
    })?;
    if !status
        .get("authenticated")
        .is_some_and(serde_json::Value::is_boolean)
        || !status
            .get("setupRequired")
            .is_some_and(serde_json::Value::is_boolean)
    {
        return Err(ConnectionFailure::new(
            "로그인 API 호환성",
            "auth_incompatible",
            "서버가 이 앱의 로그인 방식과 맞지 않습니다. 서버 버전을 확인해 주세요.",
            "authenticated/setupRequired 필드가 boolean이 아닙니다.",
        ));
    }
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let current = existing
            .url()
            .map_err(|_| "현재 서버 주소를 확인하지 못했습니다.")?;
        if current.origin() != url.origin() {
            return Err("다른 서버로 바꾸려면 현재 서버 창을 닫아 주세요.".into());
        }
        existing.show().map_err(|_| "서버 창을 열지 못했습니다.")?;
        existing
            .set_focus()
            .map_err(|_| "서버 창에 초점을 맞추지 못했습니다.")?;
        return Ok(());
    }

    require_browser_frontend(&client, &url).await?;

    let digest = Sha256::digest(url.origin().ascii_serialization().as_bytes());
    let profile = crate::portable::data_dir(&app)?
        .join("remote-webviews")
        .join(format!("{digest:x}"));
    std::fs::create_dir_all(&profile).map_err(|_| "서버별 브라우저 저장소를 만들지 못했습니다.")?;
    let allowed_origin = url.origin();
    let builder = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("모야 - 기존 서버")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 640.0)
        .data_directory(profile)
        .on_navigation(move |next| next.origin() == allowed_origin);
    #[cfg(all(debug_assertions, target_os = "windows", moya_embedded_server))]
    let builder = if let Ok(port) = std::env::var("MOYA_EMBEDDED_REMOTE_CDP_PORT")
        .unwrap_or_default()
        .parse::<u16>()
    {
        if port != 0 {
            builder.additional_browser_args(&format!("--remote-debugging-port={port}"))
        } else {
            builder
        }
    } else {
        builder
    };
    builder.build().map_err(|_| "서버 창을 열지 못했습니다.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::remote_origin;

    #[test]
    fn checks_the_served_frontend_before_opening_a_native_window() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let current = include_str!("../../index.html");
        assert!(current.contains(super::WEBVIEW_COMPATIBILITY_MARKER));
        let old = current.replace(
            super::WEBVIEW_COMPATIBILITY_MARKER,
            "name=\"description\" content=\"old UI\"",
        );
        for (body, status, code) in [
            (current.to_string(), "200 OK", None),
            (old, "200 OK", Some("frontend_incompatible")),
            ("{}".to_string(), "200 OK", Some("frontend_incompatible")),
            (current.to_string(), "302 Found", Some("http_status")),
            (
                format!("{}{}", current, "x".repeat(64 * 1024)),
                "200 OK",
                Some("frontend_too_large"),
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url =
                tauri::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() <= 4096, "request headers exceeded test limit");
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap();
            let result = runtime.block_on(super::require_browser_frontend(&client, &url));
            server.join().unwrap();
            assert_eq!(result.as_ref().err().map(|error| error.code), code);
            if let Err(error) = result {
                assert!(!error.stage.is_empty());
                assert!(!error.message.is_empty());
                assert!(!error.detail.is_empty());
            }
        }
    }

    #[test]
    fn accepts_a_server_origin_only() {
        assert_eq!(
            remote_origin("https://reader.example:8443/")
                .unwrap()
                .as_str(),
            "https://reader.example:8443/"
        );
        assert!(remote_origin("https://reader.example/api").is_err());
        assert!(remote_origin("https://user:pass@reader.example/").is_err());
        assert!(remote_origin("https://reader.example/?token=secret").is_err());
        assert!(remote_origin("file:///tmp/index.html").is_err());
        assert!(remote_origin("http://reader.example.com/").is_err());
        assert!(remote_origin("http://192.168.1.10/").is_ok());
        assert!(remote_origin("http://100.100.1.3/").is_ok());
        assert!(remote_origin("http://[fd00::1]/").is_ok());
    }
}
