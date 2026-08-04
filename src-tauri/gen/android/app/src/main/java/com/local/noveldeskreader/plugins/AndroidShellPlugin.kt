package com.local.noveldeskreader.plugins

import android.app.Activity
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val APP_LIFECYCLE_EVENT = "noveldesk://android/lifecycle"

@TauriPlugin
class AndroidShellPlugin(private val activity: Activity) : Plugin(activity) {
  override fun onResume() {
    publishLifecycle("foreground")
  }

  override fun onPause() {
    publishLifecycle("background")
  }

  private fun publishLifecycle(phase: String) {
    val payload = JSObject().apply { put("phase", phase) }
    trigger(APP_LIFECYCLE_EVENT, payload)
  }
}
