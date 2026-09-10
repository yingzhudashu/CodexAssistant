package site.codexassistant

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

private val taskTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss xxx")

val taskStatusFilters = listOf(
    "all" to "全部",
    "running" to "进行中",
    "needs_action" to "需要处理",
    "completed" to "已完成",
    "failed" to "失败",
)

/** 协议传输 UTC，界面才按设备时区转换；保留日期和偏移量，不能删掉 Z 后当成本地时间。 */
fun formatTime(value: String, zone: ZoneId = ZoneId.systemDefault()): String = try {
    taskTimeFormatter.withZone(zone).format(Instant.parse(value))
} catch (_: DateTimeParseException) {
    "时间不可用"
}

/** 卡片与通知共用同一份状态语义，新增状态不能只改界面。 */
fun statusLabel(status: String): String = when (status) {
    "active", "idle" -> "进行中"
    "waiting", "paused", "blocked", "usage_limited", "budget_limited" -> "需要处理"
    "complete", "completed" -> "已完成"
    "failed" -> "失败"
    else -> "未知状态"
}

fun canonicalTaskStatus(status: String): String = when (status) {
    "active", "idle" -> "running"
    "waiting", "paused", "blocked", "usage_limited", "budget_limited" -> "needs_action"
    "complete", "completed" -> "completed"
    "failed" -> "failed"
    else -> "needs_action"
}

data class TaskNotice(val title: String, val text: String, val detail: String, val silent: Boolean)

/** 节流只限制声音，不丢弃最终状态；调用方每次都更新同一任务的通知。 */
class TaskNotices {
    private val lastAlertAt = mutableMapOf<String, Long>()

    fun retain(ids: Set<String>) { lastAlertAt.keys.retainAll(ids) }

    fun change(previous: TaskSnapshot, next: TaskSnapshot, now: Long): TaskNotice {
        val last = lastAlertAt[next.id]
        val silent = last != null && now - last < 10_000L
        if (!silent) lastAlertAt[next.id] = now
        val transition = "${statusLabel(previous.status)} → ${statusLabel(next.status)}"
        val step = next.plan.find { it.id == next.currentStepId }?.title
        return TaskNotice("${statusLabel(next.status)} · ${next.title}", transition,
            listOfNotNull(transition, next.title, step?.let { "当前步骤：$it" }).joinToString("\n"), silent)
    }
}
