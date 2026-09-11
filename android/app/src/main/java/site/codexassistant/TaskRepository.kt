package site.codexassistant

import android.os.SystemClock
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import java.util.concurrent.TimeUnit

data class TaskState(
    val networkAvailable: Boolean? = null,
    val backgroundSyncStatus: String = "stopped",
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
    val interactions: Map<String,InteractionRequest> = emptyMap(),
    val interactionResults: Map<String,InteractionResult> = emptyMap(),
    val submittingInteractions: Set<String> = emptySet(),
)

/** One serialized connection lifecycle. Network and Activity signals come from SyncCoordinator. */
class TaskRepository internal constructor(
    private val token: () -> String?,
    private val baseUrl: () -> String,
    private val saveCursor: (Long) -> Unit,
    private val initialState: TaskState,
    private val elapsed: () -> Long = SystemClock::elapsedRealtime,
    private val client: OkHttpClient = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(30, TimeUnit.SECONDS).build(),
    private val traceLogger: TraceLogger = TraceLogger(),
    private val sockets: WebSocket.Factory = client,
) {
    constructor(credentials: CredentialStore, initial: TaskState) : this(
        credentials::token, credentials::serverBaseUrl, credentials::saveCursor, initial)

    private val lock = Any()
    private var activeSocket: WebSocket? = null
    private var recovery: ((Boolean, Boolean, Boolean) -> Unit)? = null
    private var shutdown: (() -> Unit)? = null
    private var available = initialState.networkAvailable == true
    private var closed = false
    private val json = wireJson
    private val traceClient = client.newBuilder().callTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()

    fun recover(networkAvailable: Boolean, foreground: Boolean = false, networkChanged: Boolean = false) = synchronized(lock) {
        available = networkAvailable
        recovery?.invoke(networkAvailable, foreground, networkChanged)
    }
    fun stop() = synchronized(lock) { closed = true; shutdown?.invoke() }
    private fun send(payload: String): Boolean = synchronized(lock) { !closed && activeSocket?.send(payload) == true }
    fun requestDetail(threadId: String, cursor: String? = null): String {
        val id = java.util.UUID.randomUUID().toString()
        check(send(json.encodeToString(ClientDetailMessage(requestId=id, threadId=threadId, cursor=cursor)))) { "连接不可用" }
        return id
    }
    fun sendMessage(threadId: String, text: String): String {
        require(text.trim().length in 1..20000) { "MESSAGE_INVALID" }
        val id = java.util.UUID.randomUUID().toString()
        check(send(json.encodeToString(ClientSendMessage(requestId=id, threadId=threadId, text=text.trim())))) { "连接不可用" }
        return id
    }
    fun submitInteraction(requestId: String, threadId: String, value: JsonElement): Boolean =
        send(json.encodeToString(InteractionSubmit(requestId=requestId, threadId=threadId, value=value)))

    fun stream(): Flow<TaskState> = callbackFlow {
        var state = initialState.copy(connected=false, result=null, details=emptyMap())
        var socket: WebSocket? = null
        var generation = 0L
        var retryAttempt = 0
        var retryJob: Job? = null
        var deadlineJob: Job? = null
        var deadline = 0L
        var permanentFailure = false
        var traceUploadRunning = false
        lateinit var connect: () -> Unit

        fun invalidate() {
            generation++
            activeSocket = null
            deadlineJob?.cancel(); deadlineJob = null
            socket?.cancel(); socket = null
        }
        fun publish() { trySend(state) }
        fun scheduleTraceUpload() {
            if (traceUploadRunning || closed) return
            traceUploadRunning = true
            launch(Dispatchers.IO) {
                try {
                    val accessToken = token() ?: return@launch
                    val spans = traceLogger.pending()
                    if (spans.isEmpty()) return@launch
                    val body = json.encodeToString(TraceSpanBatch(spans=spans)).toRequestBody("application/json".toMediaType())
                    val request = Request.Builder().url("${baseUrl()}/codex-assistant/api/v3/traces/spans")
                        .header("Authorization", "Bearer $accessToken").post(body).build()
                    try { traceClient.newCall(request).execute().use { if(it.isSuccessful) traceLogger.acknowledge(spans.map { span -> span.spanId }.toSet()) } } catch (_: java.io.IOException) { }
                } finally { synchronized(lock) { traceUploadRunning = false } }
            }
        }
        fun disconnected(reason: String) {
            invalidate()
            state = state.copy(connected=false, result=null, connectionStatus=if(available) "reconnecting" else "offline",
                error=reason, networkAvailable=available, retryAtEpochMs=null)
            retryJob?.cancel(); retryJob = null
            if (available && !permanentFailure && !closed) {
                val wait = (++retryAttempt).coerceAtMost(6) * 1000L
                val attemptGeneration = generation
                state = state.copy(retryAttempt=retryAttempt, retryAtEpochMs=System.currentTimeMillis()+wait)
                retryJob = launch {
                    delay(wait)
                    synchronized(lock) { if(!closed && attemptGeneration==generation && available && !permanentFailure) { retryJob=null; connect() } }
                }
            }
            publish()
        }
        fun armDeadline(at: Long) {
            deadlineJob?.cancel(); deadline=at
            val attemptGeneration=generation
            deadlineJob=launch {
                delay((at-elapsed()).coerceAtLeast(0))
                synchronized(lock) { if(!closed && generation==attemptGeneration && !state.connected && !permanentFailure) disconnected("连接握手超时，正在恢复") }
            }
        }
        connect = connect@{
            if(closed || permanentFailure) return@connect
            retryJob?.cancel(); retryJob=null
            invalidate()
            if(!available) { state=state.copy(connected=false, result=null, networkAvailable=false, connectionStatus="offline", error="等待网络恢复", retryAtEpochMs=null);publish();return@connect }
            val accessToken=token()
            if(accessToken==null) { permanentFailure=true;state=state.copy(connected=false,connectionStatus="not_configured",error="请先配置访问 Token",retryAtEpochMs=null);publish();return@connect }
            val attemptGeneration=generation
            val connectionTraceId=traceLogger.newTraceId()
            traceLogger.event("websocket.connect",connectionTraceId)
            state=state.copy(connected=false,result=null,networkAvailable=true,connectionStatus="connecting",error=null,retryAtEpochMs=null)
            publish()
            armDeadline(elapsed()+25_000)
            val request=Request.Builder().url(baseUrl().replaceFirst(Regex("^http"),"ws")+"/codex-assistant/api/v3/stream").build()
            socket=sockets.newWebSocket(request,object:WebSocketListener() {
                fun valid(ws:WebSocket)=!closed && generation==attemptGeneration && socket===ws
                override fun onOpen(webSocket:WebSocket,response:Response) { synchronized(lock) {
                    if(!valid(webSocket)) return@synchronized
                    armDeadline(minOf(deadline,elapsed()+15_000))
                    state=state.copy(connectionStatus="authenticating",error=null)
                    publish()
                    traceLogger.event("websocket.open",connectionTraceId)
                    if(!webSocket.send(json.encodeToString(ClientAuthMessage(token=accessToken)))) disconnected("认证发送失败")
                } }
                override fun onMessage(webSocket:WebSocket,text:String) { synchronized(lock) {
                    if(!valid(webSocket) || permanentFailure) return@synchronized
                    try {
                        val messageObject = json.parseToJsonElement(text).jsonObject
                        val messageType = messageObject["type"]?.jsonPrimitive?.content
                        val messageVersion = messageObject["protocolVersion"]?.jsonPrimitive?.content
                        if (messageVersion != PROTOCOL_VERSION) {
                            permanentFailure = true
                            state = state.copy(connected = false, connectionStatus = "protocol_error", error = "协议版本不受支持", retryAtEpochMs = null)
                            trySend(state)
                            invalidate()
                            return@synchronized
                        }
                        when (messageType) {
                            "authenticated" -> {
                                check(state.connectionStatus == "authenticating")
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
                                if (event.sequence <= state.cursor) return@synchronized
                                state = state.copy(cursor = event.sequence, tasks = upsert(state.tasks, event.task), error = null, lastConnectedAtEpochMs = System.currentTimeMillis(), lastTraceId = event.trace.traceId)
                                saveCursor(state.cursor)
                                trySend(state)
                            }
                            "snapshot" -> {
                                check(state.connectionStatus == "subscribing")
                                deadlineJob?.cancel(); deadlineJob = null; retryAttempt = 0
                                activeSocket = webSocket
                                val snapshot = json.decodeFromString<SnapshotMessage>(text)
                                state = traceLogger.span("websocket.snapshot.reducer", connectionTraceId) {
                                    state.copy(connected = true, connectionStatus = "connected", retryAttempt = 0, retryAtEpochMs = null, interactions = emptyMap(), interactionResults = emptyMap(), cursor = snapshot.cursor, tasks = snapshot.tasks.sortedByDescending { it.updatedAt }, error = null, lastConnectedAtEpochMs = System.currentTimeMillis())
                                }
                                scheduleTraceUpload()
                                saveCursor(state.cursor)
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
                            "interaction.request" -> {
                                val interaction = json.decodeFromString<InteractionRequest>(text)
                                state = state.copy(interactions = state.interactions + (interaction.requestId to interaction))
                                trySend(state)
                            }
                            "interaction.result" -> {
                                val result = json.decodeFromString<InteractionResult>(text)
                                state = state.copy(interactions = if (result.status == "failed") state.interactions else state.interactions - result.requestId, interactionResults = (state.interactionResults + (result.requestId to result)).entries.toList().takeLast(1000).associate { it.toPair() })
                                trySend(state)
                            }
                            "error" -> {
                                val message = json.decodeFromString<ErrorMessage>(text)
                                permanentFailure = true
                                state = state.copy(connected = false, connectionStatus = if (message.code == "auth_required") "auth_failed" else "protocol_error", error = message.message, retryAtEpochMs = null)
                                trySend(state)
                                invalidate()
                            }
                            else -> throw IllegalArgumentException("未知协议消息")
                        }
                    } catch (error: Exception) {
                        permanentFailure = true
                        state = state.copy(connected = false, connectionStatus = "protocol_error", error = error.message ?: "协议错误", retryAtEpochMs = null)
                        trySend(state)
                        invalidate()
                    }
                } }
                override fun onFailure(webSocket:WebSocket,t:Throwable,response:Response?) { synchronized(lock) {
                    if(!valid(webSocket) || permanentFailure) return@synchronized
                    if(response?.code==401 || response?.code==403) {
                        permanentFailure=true;invalidate();state=state.copy(connected=false,connectionStatus="auth_failed",error="认证失败，请编辑连接",retryAtEpochMs=null);publish()
                    } else disconnected("网络连接已断开")
                } }
                override fun onClosing(webSocket:WebSocket,code:Int,reason:String) { synchronized(lock) {
                    if(valid(webSocket) && !permanentFailure) disconnected("服务连接已关闭，正在恢复")
                } }
                override fun onClosed(webSocket:WebSocket,code:Int,reason:String) { synchronized(lock) {
                    if(valid(webSocket) && !permanentFailure) disconnected("服务连接已关闭，正在恢复")
                } }
            })
        }
        synchronized(lock) {
            check(shutdown==null) { "Repository already collected" }
            shutdown={
                invalidate();retryJob?.cancel();retryJob=null;recovery=null
                client.dispatcher.cancelAll();client.connectionPool.evictAll()
                client.dispatcher.executorService.shutdown()
            }
            recovery={ network,foreground,networkChanged ->
                val changed=state.networkAvailable!=network
                state=state.copy(networkAvailable=network)
                if(!permanentFailure && !closed) {
                    if(!network) disconnected("等待网络恢复")
                    else if(changed || networkChanged || foreground && (state.connected || socket==null || elapsed()>=deadline)) connect()
                }
                publish()
            }
            if(!closed) connect()
        }
        awaitClose { synchronized(lock) { closed=true;shutdown?.invoke();shutdown=null } }
    }
    private fun upsert(tasks:List<TaskSnapshot>,next:TaskSnapshot):List<TaskSnapshot> =
        (tasks.filterNot { it.id==next.id }+next).sortedByDescending { it.updatedAt }
}
