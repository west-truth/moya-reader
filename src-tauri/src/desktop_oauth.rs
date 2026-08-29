use serde::{Deserialize, Serialize};

pub(crate) const DROPBOX_DESKTOP_REDIRECT_URI: &str = "http://127.0.0.1:53682/oauth/dropbox";
const DROPBOX_TOKEN_URL: &str = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_OAUTH_TIMEOUT_SECS: u64 = 600;
const MAX_DROPBOX_TOKEN_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_DROPBOX_TOKEN_LENGTH: usize = 16 * 1024;
const MAX_CALLBACK_REQUEST_BYTES: usize = 128 * 1024;

struct DesktopDropboxOAuthCallback {
    code: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopDropboxOAuthCredential {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    account_id: String,
}

#[derive(Deserialize)]
struct DropboxTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    account_id: Option<String>,
    error: Option<String>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn validate_authorize_url(authorize_url: &str, expected_state: &str) -> Result<String, String> {
    if expected_state.len() < 16
        || expected_state.len() > 256
        || !expected_state
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
    {
        return Err("Dropbox OAuth state is invalid".to_string());
    }
    let url = reqwest::Url::parse(authorize_url)
        .map_err(|_| "Dropbox authorization URL is invalid".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.dropbox.com")
        || url.path() != "/oauth2/authorize"
    {
        return Err("Dropbox authorization URL is not allowed".to_string());
    }
    let query = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    if query.get("state").map(|value| value.as_ref()) != Some(expected_state)
        || query.get("redirect_uri").map(|value| value.as_ref())
            != Some(DROPBOX_DESKTOP_REDIRECT_URI)
        || query.get("response_type").map(|value| value.as_ref()) != Some("code")
        || query
            .get("code_challenge_method")
            .map(|value| value.as_ref())
            != Some("S256")
    {
        return Err("Dropbox authorization parameters are invalid".to_string());
    }
    let app_key = query
        .get("client_id")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(|| "Dropbox app key is invalid".to_string())?;
    Ok(app_key.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn validate_code_verifier(code_verifier: &str) -> Result<(), String> {
    if !(43..=128).contains(&code_verifier.len())
        || !code_verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'))
    {
        return Err("Dropbox PKCE verifier is invalid".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_system_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| "The system browser could not be opened".to_string())
}

#[cfg(target_os = "macos")]
fn open_system_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| "The system browser could not be opened".to_string())
}

#[cfg(all(
    unix,
    not(target_os = "macos"),
    not(target_os = "ios"),
    not(target_os = "android")
))]
fn open_system_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| "The system browser could not be opened".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn callback_page(success: bool) -> Vec<u8> {
    let (status, heading, detail) = if success {
        (
            "200 OK",
            "Dropbox connection received",
            "You can close this tab and return to Moya.",
        )
    } else {
        (
            "400 Bad Request",
            "Dropbox connection failed",
            "Return to Moya and try connecting again.",
        )
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Moya</title><style>body{{font:16px system-ui;background:#101419;color:#edf2f7;display:grid;place-items:center;min-height:100vh;margin:0}}main{{text-align:center;padding:24px}}h1{{font-size:22px}}p{{color:#aeb8c4}}</style></head><body><main><h1>{heading}</h1><p>{detail}</p></main></body></html>"
    );
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn read_callback_request(stream: &mut std::net::TcpStream) -> Result<String, String> {
    use std::io::Read;

    let mut request = Vec::with_capacity(4 * 1024);
    let mut chunk = [0_u8; 4 * 1024];
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| "Dropbox callback request could not be read".to_string())?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() >= MAX_CALLBACK_REQUEST_BYTES {
            return Err("Dropbox callback request was too large".to_string());
        }
    }
    if request.is_empty() || request.len() > MAX_CALLBACK_REQUEST_BYTES {
        return Err("Dropbox callback request was incomplete".to_string());
    }
    std::str::from_utf8(&request)
        .map(str::to_string)
        .map_err(|_| "Dropbox callback request was invalid".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn write_callback_page(stream: &mut std::net::TcpStream, success: bool) {
    use std::io::Write;

    let _ = stream.write_all(&callback_page(success));
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn wait_for_callback(
    listener: std::net::TcpListener,
    expected_state: String,
) -> Result<DesktopDropboxOAuthCallback, String> {
    use std::time::{Duration, Instant};

    listener
        .set_nonblocking(true)
        .map_err(|_| "Dropbox callback listener could not be configured".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(DROPBOX_OAUTH_TIMEOUT_SECS);
    loop {
        if Instant::now() >= deadline {
            return Err("Dropbox sign-in timed out".to_string());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(40));
                continue;
            }
            Err(_) => return Err("Dropbox callback could not be received".to_string()),
        };
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let request = match read_callback_request(&mut stream) {
            Ok(request) => request,
            Err(_) => {
                write_callback_page(&mut stream, false);
                continue;
            }
        };
        let target = request
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("GET "))
            .and_then(|line| line.split_whitespace().next());
        let Some(target) = target else {
            write_callback_page(&mut stream, false);
            continue;
        };
        let callback_url = match reqwest::Url::parse(&format!("http://127.0.0.1:53682{target}")) {
            Ok(value) if value.path() == "/oauth/dropbox" => value,
            _ => {
                write_callback_page(&mut stream, false);
                continue;
            }
        };
        let query = callback_url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        let state_matches = query.get("state").map(|value| value.as_ref()) == Some(&expected_state);
        let code = query
            .get("code")
            .filter(|value| !value.is_empty() && value.len() <= 4096)
            .map(|value| value.to_string());
        let error = query
            .get("error")
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(|value| value.to_string());
        let success = state_matches && code.is_some() && error.is_none();
        write_callback_page(&mut stream, success);
        if !state_matches {
            continue;
        }
        if code.is_none() && error.is_none() {
            return Err("Dropbox authorization response was incomplete".to_string());
        }
        return Ok(DesktopDropboxOAuthCallback { code, error });
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn valid_token(value: Option<String>, label: &str) -> Result<String, String> {
    value
        .filter(|value| !value.trim().is_empty() && value.len() <= MAX_DROPBOX_TOKEN_LENGTH)
        .ok_or_else(|| format!("Dropbox {} is invalid", label))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn exchange_authorization_code(
    app_key: String,
    code: String,
    code_verifier: String,
) -> Result<DesktopDropboxOAuthCredential, String> {
    let response = reqwest::Client::new()
        .post(DROPBOX_TOKEN_URL)
        .timeout(std::time::Duration::from_secs(30))
        .form(&[
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
            ("client_id", app_key.as_str()),
            ("redirect_uri", DROPBOX_DESKTOP_REDIRECT_URI),
            ("code_verifier", code_verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "Dropbox token request failed".to_string())?;
    let status = response.status();
    let response_bytes = response
        .bytes()
        .await
        .map_err(|_| "Dropbox token response could not be read".to_string())?;
    if response_bytes.len() > MAX_DROPBOX_TOKEN_RESPONSE_BYTES {
        return Err(format!(
            "Dropbox token request failed (HTTP {})",
            status.as_u16()
        ));
    }
    let body = serde_json::from_slice::<DropboxTokenResponse>(&response_bytes)
        .map_err(|_| format!("Dropbox token request failed (HTTP {})", status.as_u16()))?;
    if !status.is_success() {
        let reason = match body.error.as_deref() {
            Some("invalid_grant") => {
                " The authorization code expired or was already used. Try connecting again."
            }
            Some("invalid_client") => " Check the Dropbox app key.",
            Some("invalid_request") => " Check the registered desktop redirect URI.",
            _ => "",
        };
        return Err(format!(
            "Dropbox token request failed (HTTP {}).{}",
            status.as_u16(),
            reason
        ));
    }
    let access_token = valid_token(body.access_token, "access token")?;
    let refresh_token = match body.refresh_token {
        Some(value) => Some(valid_token(Some(value), "refresh token")?),
        None => None,
    };
    let account_id = body
        .account_id
        .filter(|value| !value.trim().is_empty() && value.len() <= 512)
        .ok_or_else(|| "Dropbox account identity is missing".to_string())?;
    if body
        .expires_in
        .is_some_and(|seconds| seconds == 0 || seconds > 31_536_000)
    {
        return Err("Dropbox token expiry is invalid".to_string());
    }
    Ok(DesktopDropboxOAuthCredential {
        access_token,
        refresh_token,
        expires_in: body.expires_in,
        account_id,
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub(crate) async fn desktop_dropbox_oauth_authorize(
    window: tauri::WebviewWindow,
    authorize_url: String,
    expected_state: String,
    code_verifier: String,
) -> Result<DesktopDropboxOAuthCredential, String> {
    let app_key = validate_authorize_url(&authorize_url, &expected_state)?;
    validate_code_verifier(&code_verifier)?;
    let listener = std::net::TcpListener::bind("127.0.0.1:53682")
        .map_err(|_| "Dropbox sign-in is already open in another Moya window".to_string())?;
    open_system_browser(&authorize_url)?;
    let callback =
        tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener, expected_state))
            .await
            .map_err(|_| "Dropbox callback task failed".to_string())??;
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if callback.error.is_some() || callback.code.is_none() {
        return Err("Dropbox authorization was cancelled".to_string());
    }
    exchange_authorization_code(app_key, callback.code.unwrap_or_default(), code_verifier).await
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub(crate) async fn desktop_dropbox_oauth_authorize(
    _window: tauri::WebviewWindow,
    _authorize_url: String,
    _expected_state: String,
    _code_verifier: String,
) -> Result<DesktopDropboxOAuthCredential, String> {
    Err("Desktop Dropbox OAuth is unavailable on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send_callback_request(
        address: std::net::SocketAddr,
        target: &str,
        delayed_write: bool,
        padding_bytes: usize,
    ) -> String {
        use std::io::{Read, Write};

        let mut stream = std::net::TcpStream::connect(address).unwrap();
        if delayed_write {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let padding = "a".repeat(padding_bytes);
        write!(
            stream,
            "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Padding: {padding}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn accepts_only_the_fixed_dropbox_pkce_redirect() {
        let state = "abcdefghijklmnopqrstuvwxyz012345";
        let valid = format!(
            "https://www.dropbox.com/oauth2/authorize?client_id=app&response_type=code&redirect_uri={}&code_challenge_method=S256&code_challenge=challenge&state={}",
            "http%3A%2F%2F127.0.0.1%3A53682%2Foauth%2Fdropbox",
            state
        );
        assert_eq!(validate_authorize_url(&valid, state).unwrap(), "app");
        assert!(
            validate_authorize_url(&valid.replace("www.dropbox.com", "example.com"), state)
                .is_err()
        );
        assert!(validate_authorize_url(&valid.replace("53682", "1421"), state).is_err());
    }

    #[test]
    fn validates_pkce_verifiers_before_opening_the_browser() {
        assert!(validate_code_verifier(&"a".repeat(43)).is_ok());
        assert!(validate_code_verifier(&"a".repeat(42)).is_err());
        assert!(validate_code_verifier(&format!("{}+", "a".repeat(42))).is_err());
    }

    #[test]
    fn callback_listener_waits_for_complete_headers_and_ignores_unrelated_state() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected_state = "expected-state-value-1234".to_string();
        let expected_state_for_thread = expected_state.clone();
        let callback = std::thread::spawn(move || {
            wait_for_callback(listener, expected_state_for_thread).unwrap()
        });

        let unrelated = send_callback_request(
            address,
            "/oauth/dropbox?code=wrong-code&state=unrelated-state-value",
            false,
            0,
        );
        assert!(unrelated.starts_with("HTTP/1.1 400 Bad Request"));

        let accepted = send_callback_request(
            address,
            &format!("/oauth/dropbox?code=accepted-code&state={expected_state}"),
            true,
            24 * 1024,
        );
        assert!(accepted.starts_with("HTTP/1.1 200 OK"));
        assert!(accepted.contains("Content-Length:"));
        assert!(accepted.contains("Dropbox connection received"));

        let callback = callback.join().unwrap();
        assert_eq!(callback.code.as_deref(), Some("accepted-code"));
        assert!(callback.error.is_none());
    }
}
