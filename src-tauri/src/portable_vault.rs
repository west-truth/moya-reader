#[cfg(moya_portable)]
mod active {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use argon2::Argon2;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Serialize};
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    const CHECK: &[u8] = b"moya-portable-source-vault-v1";
    static KEY: OnceLock<Mutex<Option<[u8; 32]>>> = OnceLock::new();

    #[derive(Deserialize, Serialize)]
    struct Header {
        version: u8,
        salt: String,
        nonce: String,
        check: String,
    }

    fn key_cell() -> &'static Mutex<Option<[u8; 32]>> {
        KEY.get_or_init(|| Mutex::new(None))
    }

    fn derive(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
        if !(12..=1024).contains(&passphrase.len()) {
            return Err("암호는 12~1024바이트로 입력해 주세요.".into());
        }
        let mut key = [0u8; 32];
        Argon2::default()
            .hash_password_into(passphrase.as_bytes(), salt, &mut key)
            .map_err(|_| "암호를 처리하지 못했습니다.")?;
        Ok(key)
    }

    fn read_header(path: &Path) -> Result<Header, String> {
        let bytes = std::fs::read(path).map_err(|_| "암호 보관소를 읽지 못했습니다.")?;
        if bytes.len() > 4096 {
            return Err("암호 보관소 형식이 올바르지 않습니다.".into());
        }
        let header: Header =
            serde_json::from_slice(&bytes).map_err(|_| "암호 보관소 형식이 올바르지 않습니다.")?;
        if header.version != 1 {
            return Err("지원하지 않는 암호 보관소 버전입니다.".into());
        }
        Ok(header)
    }

    fn unlock_at(path: &Path, passphrase: &str) -> Result<(), String> {
        let key = if path.exists() {
            let header = read_header(path)?;
            let salt = STANDARD
                .decode(header.salt)
                .map_err(|_| "암호 보관소 형식이 올바르지 않습니다.")?;
            let nonce = STANDARD
                .decode(header.nonce)
                .map_err(|_| "암호 보관소 형식이 올바르지 않습니다.")?;
            let check = STANDARD
                .decode(header.check)
                .map_err(|_| "암호 보관소 형식이 올바르지 않습니다.")?;
            if salt.len() != 16 || nonce.len() != 12 {
                return Err("암호 보관소 형식이 올바르지 않습니다.".into());
            }
            let key = derive(passphrase, &salt)?;
            let cipher =
                Aes256Gcm::new_from_slice(&key).map_err(|_| "암호를 처리하지 못했습니다.")?;
            if cipher
                .decrypt(Nonce::from_slice(&nonce), check.as_slice())
                .ok()
                .as_deref()
                != Some(CHECK)
            {
                return Err("암호가 맞지 않습니다.".into());
            }
            key
        } else {
            let mut salt = [0u8; 16];
            let mut nonce = [0u8; 12];
            getrandom::getrandom(&mut salt).map_err(|_| "암호 보관소를 만들지 못했습니다.")?;
            getrandom::getrandom(&mut nonce).map_err(|_| "암호 보관소를 만들지 못했습니다.")?;
            let key = derive(passphrase, &salt)?;
            let cipher =
                Aes256Gcm::new_from_slice(&key).map_err(|_| "암호를 처리하지 못했습니다.")?;
            let check = cipher
                .encrypt(Nonce::from_slice(&nonce), CHECK)
                .map_err(|_| "암호 보관소를 만들지 못했습니다.")?;
            let header = Header {
                version: 1,
                salt: STANDARD.encode(salt),
                nonce: STANDARD.encode(nonce),
                check: STANDARD.encode(check),
            };
            std::fs::create_dir_all(
                path.parent()
                    .ok_or("암호 보관소 경로가 올바르지 않습니다.")?,
            )
            .map_err(|_| "암호 보관소 폴더를 만들지 못했습니다.")?;
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|_| "암호 보관소를 만들지 못했습니다. 다시 시도해 주세요.")?;
            file.write_all(
                &serde_json::to_vec(&header).map_err(|_| "암호 보관소를 만들지 못했습니다.")?,
            )
            .map_err(|_| "암호 보관소를 저장하지 못했습니다.")?;
            file.sync_all()
                .map_err(|_| "암호 보관소를 저장하지 못했습니다.")?;
            key
        };
        *key_cell()
            .lock()
            .map_err(|_| "암호 보관소를 열지 못했습니다.")? = Some(key);
        Ok(())
    }

    pub(super) fn path() -> Result<std::path::PathBuf, String> {
        Ok(crate::portable::prepare()?
            .root
            .join("data/portable-vault.json"))
    }

    pub(super) fn unlock(passphrase: &str) -> Result<(), String> {
        unlock_at(&path()?, passphrase)
    }

    pub(super) fn status() -> Result<super::PortableVaultStatus, String> {
        Ok(super::PortableVaultStatus {
            supported: true,
            configured: path()?.exists(),
            unlocked: key_cell()
                .lock()
                .map_err(|_| "암호 보관소를 읽지 못했습니다.")?
                .is_some(),
        })
    }

    pub(super) fn lock() {
        if let Ok(mut key) = key_cell().lock() {
            if let Some(mut value) = key.take() {
                value.fill(0);
            }
        }
    }

    pub(super) fn key_hex() -> Result<String, String> {
        let locked = key_cell()
            .lock()
            .map_err(|_| "암호 보관소를 읽지 못했습니다.")?;
        let key = locked.as_ref().ok_or("source_vault_locked")?;
        Ok(key.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn portable_vault_requires_correct_password_and_can_reopen() {
            let directory =
                std::env::temp_dir().join(format!("moya-vault-test-{}", std::process::id()));
            let path = directory.join("vault.json");
            let _ = std::fs::remove_dir_all(&directory);
            unlock_at(&path, "a-long-test-password").unwrap();
            let first = key_hex().unwrap();
            lock();
            assert!(unlock_at(&path, "a-different-password").is_err());
            assert!(key_hex().is_err());
            unlock_at(&path, "a-long-test-password").unwrap();
            assert_eq!(key_hex().unwrap(), first);
            lock();
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableVaultStatus {
    supported: bool,
    configured: bool,
    unlocked: bool,
}

#[cfg(moya_portable)]
pub(crate) fn key_hex() -> Result<String, String> {
    active::key_hex()
}

#[tauri::command]
pub(crate) fn desktop_portable_vault_status() -> Result<PortableVaultStatus, String> {
    #[cfg(moya_portable)]
    return active::status();
    #[cfg(not(moya_portable))]
    Ok(PortableVaultStatus {
        supported: false,
        configured: false,
        unlocked: false,
    })
}

#[tauri::command]
pub(crate) fn desktop_portable_vault_unlock(
    passphrase: String,
    runtime: tauri::State<'_, crate::extension_runtime::ExtensionRuntimeManager>,
) -> Result<PortableVaultStatus, String> {
    #[cfg(moya_portable)]
    {
        active::unlock(&passphrase)?;
        runtime.stop_before_exit();
        active::status()
    }
    #[cfg(not(moya_portable))]
    {
        let _ = (passphrase, runtime);
        Err("이 버전은 포터블 암호 보관소를 지원하지 않습니다.".into())
    }
}

#[tauri::command]
pub(crate) fn desktop_portable_vault_lock(
    runtime: tauri::State<'_, crate::extension_runtime::ExtensionRuntimeManager>,
) -> Result<PortableVaultStatus, String> {
    #[cfg(moya_portable)]
    {
        runtime.stop_before_exit();
        active::lock();
        active::status()
    }
    #[cfg(not(moya_portable))]
    {
        let _ = runtime;
        Err("이 버전은 포터블 암호 보관소를 지원하지 않습니다.".into())
    }
}
