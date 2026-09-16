package site.codexassistant

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request

data class UpdateInfo(
    val version: String,
    val versionCode: Int,
    val windowsUrl: String,
    val androidUrl: String,
)

/** 网络与解析全部在 IO 调度器执行；suspend 本身不会切换线程。连接池跨检查复用。 */
class UpdateChecker(
    private val client: OkHttpClient =
        OkHttpClient.Builder().callTimeout(8, TimeUnit.SECONDS).build()
) {
    suspend fun check(baseUrl: String): UpdateInfo =
        withContext(Dispatchers.IO) {
            val request =
                Request.Builder().url("$baseUrl/codex-assistant/downloads/manifest.json").build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw IOException("更新服务返回 HTTP ${response.code}")
                // 清单只使用当前协议的固定字段，不猜测旧版本键名。
                val body = response.body ?: throw IOException("更新清单为空")
                val source = body.source()
                source.request(65_537)
                require(source.buffer.size <= 65_536) { "更新清单过大" }
                parse(source.readUtf8())
            }
        }

    companion object {
        internal fun parse(payload: String): UpdateInfo {
            try {
                val root = Json.parseToJsonElement(payload).jsonObject
                require(root.getValue("product").jsonPrimitive.content == "CodexAssistant")
                require(root.getValue("protocolVersion").jsonPrimitive.content == PROTOCOL_VERSION)
                val downloads = root.getValue("downloads").jsonObject
                val android = downloads.getValue("android").jsonObject
                fun url(platform: String): String {
                    val value =
                        downloads
                            .getValue(platform)
                            .jsonObject
                            .getValue("url")
                            .jsonPrimitive
                            .content
                    val uri = java.net.URI(value)
                    require(
                        uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null
                    )
                    return value
                }
                val version = android.getValue("versionName").jsonPrimitive.content
                val code = android.getValue("versionCode").jsonPrimitive.content.toInt()
                require(version.isNotBlank() && code > 0)
                return UpdateInfo(version, code, url("windows"), url("android"))
            } catch (_: Exception) {
                // 不把响应正文、URL 或解析器的原始异常带到 UI / 日志。
                throw IllegalArgumentException("更新清单格式或协议不正确")
            }
        }
    }
}
