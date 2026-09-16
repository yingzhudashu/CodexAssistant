package site.codexassistant

import kotlinx.serialization.json.Json

/** 必填默认字段必须发送，可选 null 字段必须省略，与服务端严格 schema 一致。 */
val wireJson = Json {
    encodeDefaults = true
    explicitNulls = false
    ignoreUnknownKeys = false
    isLenient = false
}
