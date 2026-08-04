package com.local.noveldeskreader.plugins

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class AppCredentialAccountArgs {
  lateinit var account: String
}

@InvokeArg
class AppCredentialSetArgs {
  lateinit var account: String
  lateinit var secretValue: String
}

@TauriPlugin
class AppCredentialStorePlugin(private val activity: Activity): Plugin(activity) {
  private val keyAlias = "NovelDeskAppCredentialStoreKey"
  private val preferences by lazy {
    activity.getSharedPreferences("noveldesk_app_credentials", Context.MODE_PRIVATE)
  }

  @Command
  fun setCredential(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(AppCredentialSetArgs::class.java)
      val account = validateAccount(args.account)
      val secret = args.secretValue.trim()
      if (secret.isEmpty()) {
        invoke.reject("app credential value is required")
        return
      }
      if (secret.toByteArray(StandardCharsets.UTF_8).size > 65_536) {
        invoke.reject("app credential value is too large")
        return
      }
      if (!preferences.edit().putString(account, encrypt(secret)).commit()) {
        invoke.reject("Android app credential could not be saved")
        return
      }
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android app credential could not be saved", error)
    }
  }

  @Command
  fun getCredential(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(AppCredentialAccountArgs::class.java)
      val account = validateAccount(args.account)
      val encrypted = preferences.getString(account, null)
      if (encrypted.isNullOrEmpty()) {
        invoke.reject("app credential is not configured")
        return
      }
      val response = JSObject().apply {
        put("secretValue", decrypt(encrypted))
      }
      invoke.resolve(response)
    } catch (error: Exception) {
      invoke.reject("Android app credential could not be read", error)
    }
  }

  @Command
  fun deleteCredential(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(AppCredentialAccountArgs::class.java)
      val account = validateAccount(args.account)
      if (!preferences.edit().remove(account).commit()) {
        invoke.reject("Android app credential could not be deleted")
        return
      }
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android app credential could not be deleted", error)
    }
  }

  private fun validateAccount(account: String): String {
    val value = account.trim()
    if (value.isEmpty() || value.length > 128) {
      throw IllegalArgumentException("app credential target is invalid")
    }
    if (!value.all { it.isLetterOrDigit() || it == ':' || it == '_' || it == '-' || it == '.' }) {
      throw IllegalArgumentException("app credential target contains unsupported characters")
    }
    return value
  }

  private fun encrypt(secret: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
    val ciphertext = cipher.doFinal(secret.toByteArray(StandardCharsets.UTF_8))
    return listOf(
      Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
      Base64.encodeToString(ciphertext, Base64.NO_WRAP),
    ).joinToString(":")
  }

  private fun decrypt(payload: String): String {
    val parts = payload.split(":", limit = 2)
    if (parts.size != 2) {
      throw IllegalArgumentException("app credential payload is invalid")
    }
    val iv = Base64.decode(parts[0], Base64.NO_WRAP)
    val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(128, iv))
    return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
  }

  private fun getOrCreateSecretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = keyStore.getEntry(keyAlias, null) as? KeyStore.SecretKeyEntry
    if (existing != null) return existing.secretKey

    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val specification = KeyGenParameterSpec.Builder(
      keyAlias,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
      .setKeySize(256)
      .build()
    generator.init(specification)
    return generator.generateKey()
  }
}
