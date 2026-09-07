package site.codexassistant

import android.content.Context
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.net.URI
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

class CredentialStore(context: Context) {
    val applicationContext: Context = context.applicationContext
    private val preferences = context.getSharedPreferences("codex_credentials", Context.MODE_PRIVATE)
    private val alias = "codex-assistant-token"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }
    fun token(): String? {
        val encoded = preferences.getString("token", null) ?: return null
        return try {
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            require(bytes.size > 12) { "INVALID_CREDENTIAL" }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), StandardCharsets.UTF_8)
        } catch (_: Exception) {
            // Keystore 被清空或数据损坏时清理不可恢复的凭据，让用户重新登录。
            preferences.edit().remove("token").remove("cursor").apply()
            null
        }
    }
    fun save(token: String) {
        require(token.length >= 16)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.iv + cipher.doFinal(token.toByteArray(StandardCharsets.UTF_8))
        preferences.edit().putString("token", Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply()
    }
    fun apiUrl(): String = preferences.getString("apiUrl", BuildConfig.CODEX_BASE_URL) ?: BuildConfig.CODEX_BASE_URL
    fun saveApiUrl(value: String) {
        val normalized = value.trim().removeSuffix("/")
        require(normalized.isNotBlank()) { "服务地址不能为空" }
        val uri = try { URI(normalized) } catch (_: Exception) { throw IllegalArgumentException("服务地址无效") }
        val loopback = uri.host == "localhost" || uri.host == "127.0.0.1" || uri.host == "::1" || uri.host == "[::1]"
        require(uri.userInfo == null && (uri.scheme == "https" || (uri.scheme == "http" && loopback))) { "仅允许 HTTPS；本机调试可使用回环 HTTP" }
        preferences.edit().putString("apiUrl", normalized).apply()
    }
    fun cursor(): Long = preferences.getLong("cursor", 0L)
    fun saveCursor(value: Long) { preferences.edit().putLong("cursor", value).apply() }
    fun clear() { preferences.edit().clear().apply() }
}
