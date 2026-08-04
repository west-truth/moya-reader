package com.local.noveldeskreader

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // Moya owns application navigation in React. Tauri's AppPlugin is the
  // single predictive/hardware-back source, so disable Wry's duplicate WebView
  // history callback here.
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
