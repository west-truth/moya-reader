use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Runtime,
};

const ANDROID_PLUGIN_PACKAGE: &str = "com.local.noveldeskreader.plugins";

pub(crate) fn init_android_shell<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("noveldesk-android-shell")
        .setup(|_, api| {
            api.register_android_plugin(ANDROID_PLUGIN_PACKAGE, "AndroidShellPlugin")?;
            Ok(())
        })
        .build()
}

pub(crate) fn init_android_system_tts<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("noveldesk-system-tts")
        .setup(|_, api| {
            api.register_android_plugin(ANDROID_PLUGIN_PACKAGE, "SystemTtsPlugin")?;
            Ok(())
        })
        .build()
}
