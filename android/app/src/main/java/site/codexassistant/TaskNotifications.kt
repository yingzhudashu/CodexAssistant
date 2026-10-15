package site.codexassistant

import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** 每个任务只保留最新通知内容；revision使相邻状态合并后仍能识别尚未发送的变化。 */
data class TaskChange(
    val revision: Long,
    val previousStatus: String?,
    val task: TaskSnapshot,
    val traceId: String,
    val receivedAt: Long,
    val connectionEpoch: Long = 0,
)

@Serializable
internal data class NotificationFingerprint(val key: String, val value: String, val status: String)

@Serializable
internal data class NotificationBaseline(
    val initialized: Boolean,
    val tasks: List<NotificationFingerprint>,
)

private fun digest(value: String): String =
    MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString(
        ""
    ) {
        "%02x".format(it)
    }

private fun fingerprint(task: TaskSnapshot): NotificationFingerprint {
    val stepTitle = task.plan.find { it.id == task.currentStepId }?.title
    val content =
        listOf(task.status, task.currentStepId.orEmpty(), stepTitle.orEmpty())
            .joinToString("\u0000")
    return NotificationFingerprint(digest(task.id), digest(content), task.status)
}

/** 在网络状态归约时维护基线，不能从可能跳帧的UI StateFlow推断业务变化。 */
internal class TaskChangeTracker(
    initial: TaskState,
    persisted: NotificationBaseline? = null,
    private val persist: (NotificationBaseline) -> Unit = {},
) {
    private val connectionEpoch = initial.connectionEpoch
    private var baseline = initial.tasks.associateBy { it.id }.toMutableMap()
    private var durable = persisted?.tasks.orEmpty().associateBy { it.key }.toMutableMap()
    private var initialized = baseline.isNotEmpty() || persisted?.initialized == true
    private var revision = initial.taskChanges.values.maxOfOrNull { it.revision } ?: 0L
    var changes: Map<String, TaskChange> = initial.taskChanges
        private set

    fun acknowledge(id: String, revision: Long) {
        if (changes[id]?.revision != revision) return
        changes = changes - id
        baseline[id]?.let { task ->
            val latest = fingerprint(task)
            durable[latest.key] = latest
        }
        persist(NotificationBaseline(true, durable.values.toList()))
    }

    fun event(task: TaskSnapshot, traceId: String, receivedAt: Long) {
        record(baseline[task.id]?.let(::fingerprint), task, traceId, receivedAt)
        baseline[task.id] = task
    }

    fun snapshot(tasks: List<TaskSnapshot>, traceId: String, receivedAt: Long) {
        val hadBaseline = initialized
        if (hadBaseline) {
            tasks.forEach { task ->
                val old = baseline[task.id]?.let(::fingerprint) ?: durable[digest(task.id)]
                record(old, task, traceId, receivedAt)
            }
        }
        baseline = tasks.associateBy { it.id }.toMutableMap()
        changes = changes.filterKeys { it in baseline }
        val activeKeys = baseline.values.mapTo(mutableSetOf()) { fingerprint(it).key }
        durable.keys.retainAll(activeKeys)
        initialized = true
        if (!hadBaseline)
            durable =
                baseline.values.associate { fingerprint(it).key to fingerprint(it) }.toMutableMap()
        persist(NotificationBaseline(true, durable.values.toList()))
    }

    private fun record(
        old: NotificationFingerprint?,
        next: TaskSnapshot,
        traceId: String,
        receivedAt: Long,
    ) {
        val current = fingerprint(next)
        if (old != null && old.value == current.value) return
        // 删除后重插将新变化移到末尾，只限制留存任务数，不累积每次事件。
        changes =
            (changes - next.id +
                    (next.id to
                        TaskChange(
                            ++revision,
                            old?.status,
                            next,
                            traceId,
                            receivedAt,
                            connectionEpoch,
                        )))
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
    private val postTask: (TaskChange) -> Boolean,
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
                                    if (postTask(pending.getValue(key))) {
                                        pending.remove(key)
                                        summaryTurn = true
                                        true
                                    } else false
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
