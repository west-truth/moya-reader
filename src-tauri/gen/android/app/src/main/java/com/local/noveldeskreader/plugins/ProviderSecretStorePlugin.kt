package com.local.noveldeskreader.plugins

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.local.noveldeskreader.ProviderSecretStore

@InvokeArg
class ProviderSecretAccountArgs {
  lateinit var account: String
}

@InvokeArg
class ProviderSecretSetArgs {
  lateinit var account: String
  lateinit var secretValue: String
}

@TauriPlugin
class ProviderSecretStorePlugin(private val activity: Activity): Plugin(activity) {
  @Command
  fun setSecret(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ProviderSecretSetArgs::class.java)
      ProviderSecretStore.set(activity.applicationContext, args.account, args.secretValue)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android provider secret could not be saved", error)
    }
  }

  @Command
  fun getSecret(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ProviderSecretAccountArgs::class.java)
      val secret = ProviderSecretStore.get(activity.applicationContext, args.account)
      if (secret == null) {
        invoke.reject("provider secret is not configured")
        return
      }
      invoke.resolve(JSObject().apply { put("secretValue", secret) })
    } catch (error: Exception) {
      invoke.reject("Android provider secret could not be read", error)
    }
  }

  @Command
  fun deleteSecret(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ProviderSecretAccountArgs::class.java)
      ProviderSecretStore.delete(activity.applicationContext, args.account)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android provider secret could not be deleted", error)
    }
  }
}
