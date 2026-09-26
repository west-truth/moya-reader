use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "remote-server";
const WEBVIEW_COMPATIBILITY_MARKER: &str = "name=\"moya-desktop-webview\" content=\"browser-v1\"";

async fn require_browser_frontend(
    client: &reqwest::Client,
    url: &tauri::Url,
) -> Result<(), String> {
    const INCOMPATIBLE: &str = "이 서버의 웹 화면은 앱 내 접속을 지원하지 않습니다. 서버를 업데이트하거나 일반 브라우저에서 접속해 주세요.";
    let mut response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|_| "서버 웹 화면의 호환성을 확인하지 못했습니다. 다시 시도해 주세요.")?;
    if !response.status().is_success() {
        return Err(INCOMPATIBLE.into());
    }
    // Check the served frontend, not the API version: older pages treat Tauri's
    // injected, non-configurable globals as permission to invoke native commands.
    // The small bundled index declares that it handles external WebViews as web.
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| INCOMPATIBLE)? {
        if bytes.len() + chunk.len() > 64 * 1024 {
            return Err(INCOMPATIBLE.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !String::from_utf8_lossy(&bytes).contains(WEBVIEW_COMPATIBILITY_MARKER) {
        return Err(INCOMPATIBLE.into());
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

#[tauri::command]
pub(crate) async fn desktop_remote_server_open(
    app: AppHandle,
    window: WebviewWindow,
    address: String,
) -> Result<(), String> {
    crate::embedded_server::require_local_window(&window)?;
    let url = remote_origin(&address)?;
    let status_url = url
        .join("api/auth/status")
        .map_err(|_| "서버 주소를 확인해 주세요.")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "서버 연결을 준비하지 못했습니다.")?;
    let response =
        client.get(status_url).send().await.map_err(|_| {
            "서버에 연결하지 못했습니다. 주소와 인증서를 확인한 뒤 다시 시도해 주세요."
        })?;
    if !response.status().is_success() {
        return Err(
            "서버의 로그인 화면을 확인하지 못했습니다. 모야 self-host 주소인지 확인해 주세요."
                .into(),
        );
    }
    let status: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "서버의 로그인 응답을 읽지 못했습니다.")?;
    if !status
        .get("authenticated")
        .is_some_and(serde_json::Value::is_boolean)
        || !status
            .get("setupRequired")
            .is_some_and(serde_json::Value::is_boolean)
    {
        return Err(
            "서버가 이 앱의 로그인 방식과 맞지 않습니다. 서버 버전을 확인해 주세요.".into(),
        );
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
        for (body, status, accepted) in [
            (current.to_string(), "200 OK", true),
            (old, "200 OK", false),
            ("{}".to_string(), "200 OK", false),
            (current.to_string(), "302 Found", false),
            (
                format!("{}{}", current, "x".repeat(64 * 1024)),
                "200 OK",
                false,
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
            assert_eq!(result.is_ok(), accepted, "{result:?}");
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
