use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::WebviewWindow;

#[derive(Deserialize, Serialize)]
struct ActivationAddress {
    port: u16,
    token: String,
}

fn address_file(root: &Path) -> std::path::PathBuf {
    root.join("data/activation.json")
}

pub(crate) fn activate_existing(root: &Path) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let address = std::fs::read(address_file(root))
            .ok()
            .filter(|bytes| bytes.len() < 512)
            .and_then(|bytes| serde_json::from_slice::<ActivationAddress>(&bytes).ok());
        if let Some(address) = address {
            if address.token.len() == 64
                && address.token.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                let endpoint = std::net::SocketAddr::from(([127, 0, 0, 1], address.port));
                if let Ok(mut stream) =
                    TcpStream::connect_timeout(&endpoint, Duration::from_millis(200))
                {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
                    if stream
                        .write_all(format!("{}\n", address.token).as_bytes())
                        .is_ok()
                    {
                        let _ = stream.shutdown(Shutdown::Write);
                        let mut response = String::new();
                        if BufReader::new(stream).read_line(&mut response).is_ok()
                            && response == "ok\n"
                        {
                            return true;
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

pub(crate) fn listen(window: WebviewWindow, root: &Path) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "기존 창으로 돌아가기 위한 포트를 열지 못했습니다.")?;
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).map_err(|_| "창 연결 정보를 만들지 못했습니다.")?;
    let address = ActivationAddress {
        port: listener
            .local_addr()
            .map_err(|_| "창 연결 포트를 읽지 못했습니다.")?
            .port(),
        token: secret.iter().map(|byte| format!("{byte:02x}")).collect(),
    };
    let path = address_file(root);
    std::fs::create_dir_all(path.parent().ok_or("창 연결 경로가 올바르지 않습니다.")?)
        .map_err(|_| "창 연결 폴더를 만들지 못했습니다.")?;
    std::fs::write(
        &path,
        serde_json::to_vec(&address).map_err(|_| "창 연결 정보를 만들지 못했습니다.")?,
    )
    .map_err(|_| "창 연결 정보를 저장하지 못했습니다.")?;
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            let Ok(mut stream) = incoming else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut request = String::new();
            if BufReader::new(&mut stream)
                .take(128)
                .read_to_string(&mut request)
                .is_ok()
                && request == format!("{}\n", address.token)
            {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = stream.write_all(b"ok\n");
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_process_can_contact_the_matching_profile() {
        let root = std::env::temp_dir().join(format!("moya-activation-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("data")).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = ActivationAddress {
            port: listener.local_addr().unwrap().port(),
            token: "a".repeat(64),
        };
        std::fs::write(address_file(&root), serde_json::to_vec(&address).unwrap()).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(&mut stream).read_line(&mut request).unwrap();
            assert_eq!(request, format!("{}\n", address.token));
            stream.write_all(b"ok\n").unwrap();
        });
        assert!(activate_existing(&root));
        server.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
