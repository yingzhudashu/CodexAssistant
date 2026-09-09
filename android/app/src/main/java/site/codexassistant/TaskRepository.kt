package site.codexassistant

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

data class TaskState(
    val connected: Boolean = false,
    val connectionStatus: String = "connecting",
    val cursor: Long = 0,
    val tasks: List<TaskSnapshot> = emptyList(),
    val error: String? = null,
    val retryAttempt: Int = 0,
    val retryAtEpochMs: Long? = null,
    val lastConnectedAtEpochMs: Long? = null,
    val lastTraceId: String? = null,
    val details: Map<String, DetailMessage> = emptyMap(),
    val result: ResultMessage? = null,
    val sending: Map<String,String> = emptyMap(),
    val results: Map<String,ResultMessage> = emptyMap(),
    val loadingDetails: Set<String> = emptySet(),
    val detailErrors: Map<String,String> = emptyMap(),
)

/** Android 端只负责协议接收和 reducer，不把网络细节泄漏到 Compose。 */
class TaskRepository(private val credentials: CredentialStore) {
    @Volatile private var activeSocket: WebSocket? = null
    // 协议消息的 type、protocolVersion 等字段有默认值，但它们仍是线上的必填字段。
    // kotlinx.serialization 默认会省略默认值；必须开启 encodeDefaults，否则服务端会把
    // 首条认证消息看成没有协议版本的非法消息。
    private val json = wireJson
    private val traceLogger = TraceLogger()
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    fun requestDetail(threadId: String, cursor: String? = null): String {
        val requestId = java.util.UUID.randomUUID().toString()
        check(activeSocket?.send(json.encodeToString(ClientDetailMessage(requestId = requestId, threadId = threadId, cursor = cursor))) == true) { "连接不可用" }
        return requestId
    }

    fun sendMessage(threadId: String, text: String): String {
        require(text.trim().length in 1..20000) { "MESSAGE_INVALID" }
        val requestId = java.util.UUID.randomUUID().toString()
        check(activeSocket?.send(json.encodeToString(ClientSendMessage(requestId = requestId, threadId = threadId, text = text.trim()))) == true) { "连接不可用" }
        return requestId
    }

    fun stream(): Flow<TaskState> = callbackFlow {
        var state = TaskState(cursor = credentials.cursor())
        var socket: WebSocket? = null
        var reconnectAttempt = 0
        var stopped = false
        var permanentFailure = false
        var reconnectScheduled = false
        var traceUploadRunning = false
        lateinit var connect: () -> Unit
        lateinit var scheduleReconnect: () -> Unit

        fun scheduleTraceUpload() {
            if (traceUploadRunning) return
            traceUploadRunning = true
            launch(Dispatchers.IO) {
                try {
                    val token = credentials.token() ?: return@launch
                    val base = credentials.serverBaseUrl()
                    while (true) {
                        val spans = traceLogger.pending()
                        if (spans.isEmpty()) break
                        val body = json.encodeToString(TraceSpanBatch(spans = spans)).toRequestBody("application/json".toMediaType())
                        val request = Request.Builder().url("$base/codex-assistant/api/v2/traces/spans").header("Authorization", "Bearer $token").post(body).build()
                        val response = try { client.newCall(request).execute() } catch (_: Exception) { break }
                        var uploaded = false
                        response.use {
                            if (it.isSuccessful) {
                                traceLogger.acknowledge(spans.map { span -> span.spanId }.toSet())
                                uploaded = true
                            }
                        }
                        if (!uploaded) break
                    }
                } finally {
                    traceUploadRunning = false
                }
            }
        }

        scheduleReconnect = schedule@{
            if (stopped || permanentFailure || reconnectScheduled) return@schedule
            reconnectScheduled = true
            val retryAt = System.currentTimeMillis() + (reconnectAttempt.coerceAtMost(5) + 1) * 1_000L
            state = state.copy(connected = false, connectionStatus = "reconnecting", retryAttempt = reconnectAttempt + 1, retryAtEpochMs = retryAt)
            trySend(state)
            launch {
                delay((reconnectAttempt.coerceAtMost(5) + 1) * 1_000L)
                reconnectAttempt++
                reconnectScheduled = false
                if (!stopped) connect()
            }
        }
        connect = connect@{
            val token = credentials.token()
            if (token == null) { state = state.copy(connected = false, connectionStatus = "not_configured", error = "请先配置访问 Token"); trySend(state); return@connect }
            val base = credentials.serverBaseUrl().replaceFirst(Regex("^http"), "ws")
            val request = Request.Builder().url("$base/codex-assistant/api/v2/stream").build()
            val connectionTraceId = traceLogger.newTraceId()
            traceLogger.event("websocket.connect", connectionTraceId)
            scheduleTraceUpload()
            socket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                    activeSocket = webSocket
                    reconnectAttempt = 0
                    traceLogger.event("websocket.open", connectionTraceId)
                    scheduleTraceUpload()
                    state = state.copy(connected = false, connectionStatus = "authenticating", error = null, retryAttempt = 0, retryAtEpochMs = null)
                    trySend(state)
                    webSocket.send(json.encodeToString(ClientAuthMessage(token = token)))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val messageObject = json.parseToJsonElement(text).jsonObject
                        val messageType = messageObject["type"]?.jsonPrimitive?.content
                        val messageVersion = messageObject["protocolVersion"]?.jsonPrimitive?.content
                        if (messageVersion != PROTOCOL_VERSION) {
                            permanentFailure = true
                            state = state.copy(connected = false, connectionStatus = "protocol_error", error = "协议版本不受支持", retryAtEpochMs = null)
                            trySend(state)
                            webSocket.close(1002, "protocol version")
                            return
                        }
                        when (messageType) {
                            "authenticated" -> {
                                traceLogger.event("websocket.authenticated", connectionTraceId)
                                scheduleTraceUpload()
                                state = state.copy(connectionStatus = "subscribing", error = null)
                                trySend(state)
                                webSocket.send(json.encodeToString(ClientSubscribeMessage(after = state.cursor)))
                                traceLogger.event("websocket.subscribe", connectionTraceId)
                                scheduleTraceUpload()
                            }
                            "event" -> {
                                val event = traceLogger.span("websocket.event.decode", connectionTraceId) { json.decodeFromString<EventMessage>(text).event }
                                scheduleTraceUpload()
                                if (event.sequence <= state.cursor) return
                                state = state.copy(cursor = event.sequence, tasks = upsert(state.tasks, event.task), error = null, lastConnectedAtEpochMs = System.currentTimeMillis(), lastTraceId = event.trace.traceId)
                                credentials.saveCursor(state.cursor)
                                trySend(state)
                            }
                            "snapshot" -> {
                                val snapshot = json.decodeFromString<SnapshotMessage>(text)
                                state = traceLogger.span("websocket.snapshot.reducer", connectionTraceId) {
                                    state.copy(connected = true, connectionStatus = "connected", cursor = snapshot.cursor, tasks = snapshot.tasks.sortedByDescending { it.updatedAt }, error = null, lastConnectedAtEpochMs = System.currentTimeMillis())
                                }
                                scheduleTraceUpload()
                                credentials.saveCursor(state.cursor)
                                trySend(state)
                            }
                            "detail" -> {
                                val detail = json.decodeFromString<DetailMessage>(text)
                                state = state.copy(details = state.details + (detail.threadId to detail), result = null)
                                trySend(state)
                            }
                            "result" -> {
                                state = state.copy(result = json.decodeFromString<ResultMessage>(text))
                                trySend(state)
                            }
                            "error" -> {
                                val message = json.decodeFromString<ErrorMessage>(text)
                                permanentFailure = message.code == "auth_required" || message.code == "protocol_unsupported" || message.code == "validation_failed"
                                state = state.copy(connected = false, connectionStatus = if (message.code == "auth_required") "auth_failed" else "protocol_error", error = message.message, retryAtEpochMs = null)
                                trySend(state)
                                webSocket.close(1008, "protocol error")
                            }
                            else -> throw IllegalArgumentException("未知协议消息")
                        }
                    } catch (error: Exception) {
                        permanentFailure = true
                        state = state.copy(connected = false, connectionStatus = "protocol_error", error = error.message ?: "协议错误", retryAtEpochMs = null)
                        trySend(state)
                        webSocket.close(1008, "protocol error")
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                    traceLogger.event("websocket.failure", connectionTraceId)
                    scheduleTraceUpload()
                    if (stopped || permanentFailure) return
                    state = state.copy(connected = false, connectionStatus = "offline", error = "网络连接已断开")
                    trySend(state)
                    scheduleReconnect()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (activeSocket === webSocket) activeSocket = null
                    traceLogger.event("websocket.closed", connectionTraceId)
                    scheduleTraceUpload()
                    if (stopped || permanentFailure) return
                    state = state.copy(connected = false, connectionStatus = "reconnecting")
                    trySend(state)
                    scheduleReconnect()
                }
            })
        }
        connect()
        awaitClose {
            stopped = true
            activeSocket = null
            socket?.close(1000, "leaving")
            client.connectionPool.evictAll()
            client.dispatcher.cancelAll()
            client.dispatcher.executorService.shutdown()
        }
    }

    private fun upsert(tasks: List<TaskSnapshot>, next: TaskSnapshot): List<TaskSnapshot> =
        (tasks.filterNot { it.id == next.id } + next).sortedByDescending { it.updatedAt }
}
