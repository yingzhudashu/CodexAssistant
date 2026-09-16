package site.codexassistant

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 每个任务只保留最新通知内容；revision使相邻状态合并后仍能识别尚未发送的变化。 */
data class TaskChange(
    val revision: Long,
    val previous: TaskSnapshot?,
    val task: TaskSnapshot,
    val traceId: String,
    val receivedAt: Long,
    val connectionEpoch: Long = 0,
)

/** 在网络状态归约时维护基线，不能从可能跳帧的UI StateFlow推断业务变化。 */
internal class TaskChangeTracker(initial: TaskState) {
    private val connectionEpoch = initial.connectionEpoch
    private var baseline = initial.tasks.associateBy { it.id }.toMutableMap()
    private var initialized = initial.tasks.isNotEmpty()
    private var revision = initial.taskChanges.values.maxOfOrNull { it.revision } ?: 0L
    var changes: Map<String, TaskChange> = initial.taskChanges
        private set

    fun acknowledge(id: String, revision: Long) {
        if (changes[id]?.revision == revision) changes = changes - id
    }

    fun event(task: TaskSnapshot, traceId: String, receivedAt: Long) {
        record(baseline[task.id], task, traceId, receivedAt)
        baseline[task.id] = task
    }

    fun snapshot(tasks: List<TaskSnapshot>, traceId: String, receivedAt: Long) {
        if (initialized) tasks.forEach { record(baseline[it.id], it, traceId, receivedAt) }
        baseline = tasks.associateBy { it.id }.toMutableMap()
        changes = changes.filterKeys { it in baseline }
        initialized = true
    }

    private fun record(old: TaskSnapshot?, next: TaskSnapshot, traceId: String, receivedAt: Long) {
        if (
            old != null &&
                old.status == next.status &&
                old.currentStepId == next.currentStepId &&
                old.plan.find { it.id == old.currentStepId }?.title ==
                    next.plan.find { it.id == next.currentStepId }?.title
        )
            return
        // 删除后重插将新变化移到末尾，只限制留存任务数，不累积每次事件。
        changes =
            (changes - next.id +
                    (next.id to
                        TaskChange(++revision, old, next, traceId, receivedAt, connectionEpoch)))
                .entries
                .toList()
                .takeLast(1000)
                .associate { it.toPair() }
    }
}

internal data class NotificationSnapshot(
    val connection: String,
    val running: Int,
    val needsAction: Int,
) {
    val text: String
        get() = "$connection · $running 个进行中 · $needsAction 个待确认"
}

internal fun notificationSnapshot(state: TaskState) =
    NotificationSnapshot(
        connectionSummary(state),
        state.tasks.count { it.status == "running" },
        state.tasks.count { it.status == "needs_action" },
    )

/** 一条发送协程共享系统通知预算；固定发送间隔不会像debounce一样被新事件无限推迟。 */
internal class NotificationDelivery(
    scope: CoroutineScope,
    private val postTask: (TaskChange) -> Unit,
    private val postSummary: (NotificationSnapshot) -> Unit,
    private val reset: () -> Unit = {},
    private val workChanged: (Boolean) -> Unit = {},
) {
    private val lock = Any()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val pending = LinkedHashMap<String, TaskChange>()
    private val seen = mutableMapOf<String, Long>()
    private var epoch: Long? = null
    private var summary: NotificationSnapshot? = null
    private var postedSummary: NotificationSnapshot? = null
    private var summaryTurn = false

    init {
        scope.launch {
            for (ignored in wake) {
                while (true) {
                    val sent =
                        synchronized(lock) {
                            // 在同一锁内取出并提交，配置切换不能夹在二者之间发出旧账户通知。
                            val currentSummary = summary
                            when {
                                currentSummary != null && (pending.isEmpty() || summaryTurn) -> {
                                    postSummary(currentSummary)
                                    postedSummary = currentSummary
                                    summary = null
                                    summaryTurn = false
                                    true
                                }
                                pending.isNotEmpty() -> {
                                    val key = pending.keys.first()
                                    postTask(pending.remove(key)!!)
                                    summaryTurn = true
                                    true
                                }
                                else -> false
                            }
                        }
                    workChanged(sent)
                    if (!sent) break
                    delay(300)
                }
            }
        }
    }

    fun update(state: TaskState): Unit =
        synchronized(lock) {
            if (epoch != state.connectionEpoch) {
                if (epoch != null) reset()
                epoch = state.connectionEpoch
                pending.clear()
                seen.clear()
                postedSummary = null
                summary = null
            }
            val nextSummary = notificationSnapshot(state)
            summary = nextSummary.takeIf { it != postedSummary }
            // 未连通时保留已确认的待发事件；快照恢复后的新增变化由tracker统一补齐。
            for ((id, change) in state.taskChanges) {
                if ((seen[id] ?: 0) >= change.revision) continue
                seen[id] = change.revision
                pending[id] = change
            }
            seen.keys.retainAll(state.taskChanges.keys)
            pending.keys.retainAll(state.taskChanges.keys)
            if (pending.isNotEmpty() || summary != null) workChanged(true)
            wake.trySend(Unit)
            Unit
        }
}
