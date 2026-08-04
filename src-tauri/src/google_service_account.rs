use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
pub(crate) struct GoogleServiceAccountCredential {
    pub(crate) client_email: String,
    pub(crate) private_key: String,
    pub(crate) project_id: Option<String>,
    pub(crate) token_uri: Option<String>,
}
fn resolve_google_service_account_credential_path(path: &str) -> Result<PathBuf, String> {
    let credential_path = path.trim();
    if credential_path.is_empty() {
        return Err("Vertex credential path is required".to_string());
    }
    let source = Path::new(credential_path);
    let metadata = std::fs::metadata(source)
        .map_err(|_| "Vertex credential path could not be read".to_string())?;
    if metadata.is_file() {
        return Ok(source.to_path_buf());
    }
    if !metadata.is_dir() {
        return Err("Vertex credential path must be a JSON file or directory".to_string());
    }
    let mut json_files = Vec::new();
    for entry in std::fs::read_dir(source)
        .map_err(|_| "Vertex credential directory could not be read".to_string())?
    {
        let entry =
            entry.map_err(|_| "Vertex credential directory could not be read".to_string())?;
        let entry_path = entry.path();
        if entry_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            json_files.push(entry_path);
        }
    }
    match json_files.len() {
        1 => Ok(json_files.remove(0)),
        0 => Err("Vertex credential directory contains no JSON credential file".to_string()),
        _ => Err(
            "Vertex credential directory contains multiple JSON files; store the exact file path"
                .to_string(),
        ),
    }
}

pub(crate) fn read_google_service_account_credential(
    path: &str,
) -> Result<GoogleServiceAccountCredential, String> {
    let credential_path = resolve_google_service_account_credential_path(path)?;
    let credential_text = std::fs::read_to_string(credential_path)
        .map_err(|_| "Vertex credential file could not be read".to_string())?;
    let credential: GoogleServiceAccountCredential = serde_json::from_str(&credential_text)
        .map_err(|_| "Vertex credential file could not be parsed".to_string())?;
    if credential.client_email.trim().is_empty() || credential.private_key.trim().is_empty() {
        return Err(
            "Vertex credential file is missing required service-account fields".to_string(),
        );
    }
    Ok(credential)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!("noveldesk-tauri-test-{}-{}", name, unique))
    }

    fn dummy_service_account_json(project_id: &str) -> String {
        format!(
            r#"{{
  "type": "service_account",
  "project_id": "{}",
  "private_key_id": "dummy",
  "private_key": "-----BEGIN PRIVATE KEY-----\nDUMMY\n-----END PRIVATE KEY-----\n",
  "client_email": "noveldesk-test@example.iam.gserviceaccount.com",
  "token_uri": "https://oauth2.googleapis.com/token"
}}"#,
            project_id
        )
    }
    #[test]
    fn resolves_single_json_credential_directory() {
        let directory = temp_test_path("credential-dir");
        std::fs::create_dir_all(&directory).expect("create temp credential dir");
        let credential_path = directory.join("service-account.json");
        std::fs::write(&credential_path, dummy_service_account_json("demo-project"))
            .expect("write temp credential");

        let resolved = resolve_google_service_account_credential_path(
            directory.to_str().expect("utf-8 temp path"),
        )
        .expect("resolve credential path");
        let credential =
            read_google_service_account_credential(directory.to_str().expect("utf-8 temp path"))
                .expect("parse credential");

        assert_eq!(resolved, credential_path);
        assert_eq!(credential.project_id.as_deref(), Some("demo-project"));

        std::fs::remove_dir_all(directory).expect("remove temp credential dir");
    }

    #[test]
    fn rejects_ambiguous_credential_directory() {
        let directory = temp_test_path("credential-ambiguous-dir");
        std::fs::create_dir_all(&directory).expect("create temp credential dir");
        std::fs::write(
            directory.join("one.json"),
            dummy_service_account_json("demo-project"),
        )
        .expect("write first credential");
        std::fs::write(
            directory.join("two.json"),
            dummy_service_account_json("demo-project"),
        )
        .expect("write second credential");

        let error = resolve_google_service_account_credential_path(
            directory.to_str().expect("utf-8 temp path"),
        )
        .expect_err("ambiguous directory should fail");
        assert!(error.contains("multiple JSON files"));

        std::fs::remove_dir_all(directory).expect("remove temp credential dir");
    }
}
