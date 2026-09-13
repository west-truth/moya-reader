//! Desktop OAuth uses the system browser, PKCE and the OS credential store.
//! The desktop OAuth client belongs to the distributor, never to an end user.
use serde::Serialize;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoogleSession {
    configured: bool,
    account_id: Option<String>,
    label: Option<String>,
    drive_ready: bool,
    access_token: Option<String>,
    expires_at: Option<u64>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const DRIVE: &str = "https://www.googleapis.com/auth/drive.file";
    const CLIENT: &str = match option_env!("MOYA_GOOGLE_DESKTOP_CLIENT_ID") {
        Some(value) => value,
        None => "",
    };
    static OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[derive(Deserialize, Serialize)]
    struct Credential {
        client_id: String,
        account_id: String,
        label: String,
        access_token: String,
        refresh_token: Option<String>,
        expires_at: u64,
        drive: bool,
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new("Moya App Credentials", "noveldesk:cloud_vault_google_oauth")
            .map_err(|_| "Google 연결의 보안 저장소를 열지 못했습니다.".into())
    }

    fn load() -> Result<Option<Credential>, String> {
        match entry()?.get_secret() {
            Ok(value) => {
                let saved: Credential = serde_json::from_slice(&value).map_err(|_| {
                    "저장된 Google 연결을 읽지 못했습니다. 다시 연결하세요.".to_string()
                })?;
                Ok((saved.client_id == CLIENT).then_some(saved))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Google 연결의 보안 저장소를 읽지 못했습니다.".into()),
        }
    }

    fn save(value: &Credential) -> Result<(), String> {
        let bytes = serde_json::to_vec(value)
            .map_err(|_| "Google 연결을 저장하지 못했습니다.".to_string())?;
        entry()?
            .set_secret(&bytes)
            .map_err(|_| "Google 연결을 보안 저장소에 저장하지 못했습니다.".into())
    }

    fn snapshot(value: Option<&Credential>, token: bool) -> GoogleSession {
        GoogleSession {
            configured: !CLIENT.is_empty(),
            account_id: value.map(|v| v.account_id.clone()),
            label: value.map(|v| v.label.clone()),
            drive_ready: value.is_some_and(|v| {
                v.drive && (v.expires_at > now() + 60 || v.refresh_token.is_some())
            }),
            access_token: value.filter(|_| token).map(|v| v.access_token.clone()),
            expires_at: value.filter(|_| token).map(|v| v.expires_at * 1000),
        }
    }

    fn random() -> Result<String, String> {
        let mut bytes = [0_u8; 32];
        getrandom::getrandom(&mut bytes)
            .map_err(|_| "Google 연결을 준비하지 못했습니다.".to_string())?;
        Ok(URL_SAFE_NO_PAD.encode(bytes))
    }

    fn client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Google 연결을 준비하지 못했습니다.".into())
    }

    async fn json(mut response: reqwest::Response) -> Result<serde_json::Value, String> {
        if !response.status().is_success() {
            return Err(format!(
                "Google 연결 요청에 실패했습니다 ({}). 다시 연결하세요.",
                response.status().as_u16()
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Google 응답을 읽지 못했습니다.".to_string())?
        {
            if body.len() + chunk.len() > 64 * 1024 {
                return Err("Google 응답이 너무 큽니다.".into());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| "Google 응답을 확인하지 못했습니다.".into())
    }

    fn field(value: &serde_json::Value, key: &str) -> Result<String, String> {
        value[key]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 8192)
            .map(str::to_string)
            .ok_or_else(|| "Google 연결 응답이 불완전합니다.".into())
    }

    async fn tokens(mut form: Vec<(&str, String)>) -> Result<serde_json::Value, String> {
        form.push(("client_id", CLIENT.into()));
        if let Some(secret) =
            option_env!("MOYA_GOOGLE_DESKTOP_CLIENT_SECRET").filter(|s| !s.is_empty())
        {
            form.push(("client_secret", secret.into()));
        }
        let response = client()?
            .post("https://oauth2.googleapis.com/token")
            .form(&form)
            .send()
            .await
            .map_err(|_| "Google 연결 요청에 실패했습니다. 네트워크를 확인하세요.".to_string())?;
        json(response).await
    }

    fn expiry(value: &serde_json::Value) -> Result<u64, String> {
        value["expires_in"]
            .as_u64()
            .filter(|v| *v > 60 && *v <= 86400)
            .map(|v| now() + v)
            .ok_or_else(|| "Google 연결 만료 시간을 확인하지 못했습니다.".into())
    }

    async fn authorize(drive: bool, expected: Option<&str>) -> Result<Credential, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|_| "Google 로그인 창을 준비하지 못했습니다.".to_string())?;
        let port = listener
            .local_addr()
            .map_err(|_| "Google 로그인 주소를 준비하지 못했습니다.".to_string())?
            .port();
        let redirect = format!("http://127.0.0.1:{port}/");
        let state = random()?;
        let verifier = random()?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
        let scope = if drive {
            format!("openid email {DRIVE}")
        } else {
            "openid email".into()
        };
        url.query_pairs_mut().extend_pairs([
            ("client_id", CLIENT),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("scope", &scope),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ]);
        if let Some(account) = expected {
            url.query_pairs_mut().append_pair("login_hint", account);
        }
        crate::desktop_oauth::open_system_browser(url.as_str())?;
        let callback = tauri::async_runtime::spawn_blocking(move || {
            crate::desktop_oauth::wait_for_provider_callback(listener, state, "/")
        })
        .await
        .map_err(|_| "Google 로그인을 완료하지 못했습니다.".to_string())??;
        if callback.error.is_some() {
            return Err("Google 연결이 취소됐습니다.".into());
        }
        let code = callback
            .code
            .ok_or("Google 로그인을 완료하지 못했습니다.")?;
        let token = tokens(vec![
            ("grant_type", "authorization_code".into()),
            ("code", code),
            ("redirect_uri", redirect),
            ("code_verifier", verifier),
        ])
        .await?;
        let access_token = field(&token, "access_token")?;
        let info = json(
            client()?
                .get("https://openidconnect.googleapis.com/v1/userinfo")
                .bearer_auth(&access_token)
                .send()
                .await
                .map_err(|_| "Google 계정을 확인하지 못했습니다.".to_string())?,
        )
        .await?;
        credential(&token, &info, drive, expected)
    }

    fn credential(
        token: &serde_json::Value,
        info: &serde_json::Value,
        drive: bool,
        expected: Option<&str>,
    ) -> Result<Credential, String> {
        let access_token = field(token, "access_token")?;
        let granted = token["scope"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .any(|s| s == DRIVE);
        if drive && !granted {
            return Err("Drive 접근 권한이 허용되지 않았습니다.".into());
        }
        let account_id = field(&info, "sub")?;
        if expected.is_some_and(|id| id != account_id) {
            return Err(
                "기존 연결과 다른 Google 계정입니다. 기존 연결을 해제한 뒤 다시 시도하세요.".into(),
            );
        }
        let label = info["email"]
            .as_str()
            .filter(|v| v.len() <= 512)
            .unwrap_or("Google 계정")
            .to_string();
        Ok(Credential {
            client_id: CLIENT.into(),
            account_id,
            label,
            access_token,
            refresh_token: token["refresh_token"]
                .as_str()
                .filter(|v| v.len() <= 8192)
                .map(str::to_string),
            expires_at: expiry(&token)?,
            drive: granted,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn consent_and_account_must_match_before_credentials_are_saved() {
            let info = serde_json::json!({"sub":"reader","email":"reader@example.test"});
            let mut token = serde_json::json!({"access_token":"test-token","expires_in":3600,"scope":"openid email"});
            assert!(!credential(&token, &info, false, None).unwrap().drive);
            assert!(credential(&token, &info, true, Some("reader")).is_err());
            token["scope"] = serde_json::json!(DRIVE);
            assert!(credential(&token, &info, true, Some("other-reader")).is_err());
            assert!(
                credential(&token, &info, true, Some("reader"))
                    .unwrap()
                    .drive
            );
            token["expires_in"] = serde_json::json!(0);
            assert!(credential(&token, &info, true, Some("reader")).is_err());
        }
        #[test]
        fn tokens_are_excluded_from_status_and_pkce_is_random() {
            let value = credential(&serde_json::json!({"access_token":"private-token","expires_in":3600,"scope":DRIVE}),
                &serde_json::json!({"sub":"reader"}), true, None).unwrap();
            assert!(snapshot(Some(&value), false).access_token.is_none());
            assert_eq!(
                snapshot(Some(&value), true).access_token.as_deref(),
                Some("private-token")
            );
            let first = random().unwrap();
            assert_eq!(first.len(), 43);
            assert_ne!(first, random().unwrap());
        }
    }

    pub(super) async fn run(
        action: &str,
        expected: Option<String>,
    ) -> Result<GoogleSession, String> {
        let _guard = OPERATION
            .try_lock()
            .map_err(|_| "Google 연결을 처리 중입니다.".to_string())?;
        if action == "status" {
            if CLIENT.is_empty() {
                return Ok(snapshot(None, false));
            }
            return Ok(snapshot(load()?.as_ref(), false));
        }
        if action == "logout" {
            match entry()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => return Ok(snapshot(None, false)),
                Err(_) => return Err("Google 연결을 해제하지 못했습니다.".into()),
            }
        }
        if CLIENT.is_empty() {
            return Err("이 데스크톱 빌드에는 Google 로그인이 구성되지 않았습니다.".into());
        }
        if action == "login" || action == "connect" {
            let value = authorize(action == "connect", expected.as_deref()).await?;
            save(&value)?;
            return Ok(snapshot(Some(&value), false));
        }
        if action != "token" {
            return Err("지원하지 않는 Google 연결 작업입니다.".into());
        }
        let mut value = load()?.ok_or("Google 로그인이 필요합니다.")?;
        if expected.as_deref() != Some(&value.account_id) || !value.drive {
            return Err("Google Drive 계정을 다시 연결하세요.".into());
        }
        if value.expires_at <= now() + 60 {
            let refresh = value
                .refresh_token
                .as_ref()
                .ok_or("Google Drive를 다시 연결하세요.")?;
            let token = tokens(vec![
                ("grant_type", "refresh_token".into()),
                ("refresh_token", refresh.clone()),
            ])
            .await?;
            value.access_token = field(&token, "access_token")?;
            value.expires_at = expiry(&token)?;
            save(&value)?;
        }
        Ok(snapshot(Some(&value), true))
    }
}

#[tauri::command]
pub(crate) async fn desktop_google_oauth(
    action: String,
    expected_account_id: Option<String>,
) -> Result<GoogleSession, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        desktop::run(&action, expected_account_id).await
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (action, expected_account_id);
        Err("이 기기에서는 데스크톱 Google 로그인을 사용할 수 없습니다.".into())
    }
}
