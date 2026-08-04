package com.local.noveldeskreader

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object ProviderSecretStore {
  private const val KEY_ALIAS = "NovelDeskProviderSecretStoreKey"
  private const val PREFERENCES = "noveldesk_provider_secrets"

  fun set(context: Context, account: String, secret: String) {
    preferences(context).edit().putString(validateAccount(account), encrypt(secret)).apply()
  }

  fun get(context: Context, account: String): String? {
    val encrypted = preferences(context).getString(validateAccount(account), null) ?: return null
    return decrypt(encrypted).takeIf { it.isNotBlank() }
  }

  fun delete(context: Context, account: String) {
    preferences(context).edit().remove(validateAccount(account)).apply()
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  private fun validateAccount(account: String): String {
    val value = account.trim()
    require(value.isNotEmpty()) { "provider secret target is invalid" }
    require(value.length <= 256) { "provider secret target is too long" }
    require(value.all { it.isLetterOrDigit() || it == ':' || it == '_' || it == '-' || it == '.' }) {
      "provider secret target contains unsupported characters"
    }
    return value
  }

  private fun encrypt(secret: String): String {
    val value = secret.trim()
    require(value.isNotEmpty()) { "provider secret value is required" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
    val ciphertext = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
    return listOf(
      Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
      Base64.encodeToString(ciphertext, Base64.NO_WRAP),
    ).joinToString(":")
  }

  private fun decrypt(payload: String): String {
    val parts = payload.split(":")
    require(parts.size == 2) { "provider secret payload is invalid" }
    val iv = Base64.decode(parts[0], Base64.NO_WRAP)
    val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(128, iv))
    return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
  }

  private fun getOrCreateSecretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
    if (existing != null) return existing.secretKey
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val spec = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
      .setKeySize(256)
      .build()
    generator.init(spec)
    return generator.generateKey()
  }
}
