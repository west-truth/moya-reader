#[cfg(target_os = "android")]
use super::cache_contract::{
    NativeTTSRecoveryChargingPolicy, NativeTTSRecoveryNetworkPolicy, NativeTTSRecoveryPolicy,
};
#[cfg(target_os = "android")]
use serde::Serialize;
#[cfg(target_os = "android")]
use tauri::{
    plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
const ANDROID_NATIVE_TTS_RECOVERY_PLUGIN: &str = "nativeTtsRecovery";

#[cfg(target_os = "android")]
struct AndroidNativeTTSRecovery<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleRequest {
    network: &'static str,
    charging: &'static str,
}

#[cfg(target_os = "android")]
pub(crate) async fn schedule(
    app: &tauri::AppHandle,
    policy: NativeTTSRecoveryPolicy,
) -> Result<(), String> {
    let recovery = app
        .try_state::<AndroidNativeTTSRecovery<tauri::Wry>>()
        .ok_or_else(|| "Android native TTS recovery scheduler is unavailable".to_string())?;
    recovery
        .0
        .run_mobile_plugin_async::<()>(
            "schedule",
            ScheduleRequest {
                network: match policy.network {
                    NativeTTSRecoveryNetworkPolicy::Any => "any",
                    NativeTTSRecoveryNetworkPolicy::Unmetered => "unmetered",
                },
                charging: match policy.charging {
                    NativeTTSRecoveryChargingPolicy::Any => "any",
                    NativeTTSRecoveryChargingPolicy::Required => "required",
                },
            },
        )
        .await
        .map_err(|error| format!("Android native TTS recovery scheduling failed: {error}"))
}

#[cfg(target_os = "android")]
pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new(ANDROID_NATIVE_TTS_RECOVERY_PLUGIN)
        .setup(|app, api| {
            let handle = api.register_android_plugin(
                "com.local.noveldeskreader.plugins",
                "NativeTtsRecoveryPlugin",
            )?;
            app.manage(AndroidNativeTTSRecovery(handle));
            Ok(())
        })
        .build()
}
