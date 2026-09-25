use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "remote-server";

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

    let digest = Sha256::digest(url.origin().ascii_serialization().as_bytes());
    let profile = crate::portable::data_dir(&app)?
        .join("remote-webviews")
        .join(format!("{digest:x}"));
    std::fs::create_dir_all(&profile).map_err(|_| "서버별 브라우저 저장소를 만들지 못했습니다.")?;
    let allowed_origin = url.origin();
    WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("모야 - 기존 서버")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 640.0)
        .data_directory(profile)
        .on_navigation(move |next| next.origin() == allowed_origin)
        .build()
        .map_err(|_| "서버 창을 열지 못했습니다.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::remote_origin;

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
    }
}
