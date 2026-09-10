package site.codexassistant

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 进程内唯一的同步入口。前台服务负责维持生命周期，Compose 只订阅状态，
 * 避免界面和服务各自打开 WebSocket 造成重复流量和重复通知。
 */
class SyncCoordinator(context: Context) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutableState = MutableStateFlow(TaskState())
    private var job: Job? = null
    @Volatile private var repository: TaskRepository? = null

    fun state(): StateFlow<TaskState> = mutableState.asStateFlow()

    @Synchronized
    fun start() {
        if (job?.isActive == true) return
        val credentials = CredentialStore(appContext)
        mutableState.value = mutableState.value.copy(cursor = credentials.cursor())
        val nextRepository = TaskRepository(credentials)
        repository = nextRepository
        job = scope.launch {
            nextRepository.stream().collect { if (repository === nextRepository) mutableState.value = it }
        }
    }

    @Synchronized
    fun stop() {
        repository = null
        job?.cancel()
        job = null
        mutableState.value = mutableState.value.copy(connected = false, connectionStatus = "offline", error = "同步服务已停止，打开应用后恢复")
    }

    /** 保存新凭据后丢弃旧连接状态，并立刻按新地址和 Token 重建唯一 WebSocket。 */
    @Synchronized
    fun restart() {
        stop()
        mutableState.value = TaskState(cursor = CredentialStore(appContext).cursor())
        start()
    }

    fun requestDetail(threadId: String, cursor: String? = null): String = repository?.requestDetail(threadId, cursor) ?: error("连接不可用")
    fun sendMessage(threadId: String, text: String): String = repository?.sendMessage(threadId, text) ?: error("连接不可用")
    fun submitInteraction(requestId: String, threadId: String, value: kotlinx.serialization.json.JsonElement): Boolean = repository?.submitInteraction(requestId, threadId, value) == true
}
