//! Holds an OS file lock until the Node launcher has drained all managed services.
//! The lock survives a UI crash and is released by the OS after a power loss.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use std::{
    fs::OpenOptions,
    process::{Command, Stdio},
};

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let profile = std::path::PathBuf::from(args.next().ok_or("Missing profile")?);
    let executable = args.next().ok_or("Missing launcher")?;
    std::fs::create_dir_all(&profile)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(profile.join(".server-owner.lock"))?;
    lock.try_lock()
        .map_err(|_| "이 서재를 사용하는 모야 서버가 이미 실행 중입니다.")?;
    let mut command = Command::new(executable);
    command
        .args(args)
        .env("MOYA_PROFILE_GUARDED", "1")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let status = command.spawn()?.wait()?;
    drop(lock);
    Ok(status.code().unwrap_or(1))
}

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({"event": "error", "message": error.to_string()})
            );
            1
        }
    };
    std::process::exit(code);
}
