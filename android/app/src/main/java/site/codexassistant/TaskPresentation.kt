package site.codexassistant

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

private val taskTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss xxx")

val taskStatusFilters =
    listOf(
        "all" to "全部",
        "running" to "进行中",
        "completed" to "已完成",
        "failed" to "失败",
        "needs_action" to "待确认",
    )

/** 协议传输 UTC，界面才按设备时区转换；保留日期和偏移量，不能删掉 Z 后当成本地时间。 */
fun formatTime(value: String, zone: ZoneId = ZoneId.systemDefault()): String =
    try {
        taskTimeFormatter.withZone(zone).format(Instant.parse(value))
    } catch (_: DateTimeParseException) {
        "时间不可用"
    }

/** 卡片与通知共用同一份状态语义，新增状态不能只改界面。 */
fun statusLabel(status: String): String =
    when (status) {
        "running" -> "进行中"
        "needs_action" -> "待确认"
        "completed" -> "已完成"
        "failed" -> "失败"
        else -> "未知状态"
    }

data class TaskNotice(val title: String, val text: String, val detail: String, val silent: Boolean)

/** 普通进度声音节流不能压住首次待确认/完成/失败提醒；文本始终更新为最新状态。 */
class TaskNotices {
    private val lastAlertAt = mutableMapOf<String, MutableMap<String, Long>>()

    fun retain(ids: Set<String>) {
        lastAlertAt.keys.retainAll(ids)
    }

    fun change(previous: TaskSnapshot?, next: TaskSnapshot, now: Long): TaskNotice {
        val alerts = lastAlertAt.getOrPut(next.id) { mutableMapOf() }
        val important = next.status != "running" && previous?.status != next.status
        val last = if (important) alerts[next.status] else alerts.values.maxOrNull()
        val silent = last != null && now - last < 10_000L
        if (!silent) alerts[next.status] = now
        val transition =
            if (previous == null) "新任务 · ${statusLabel(next.status)}"
            else "${statusLabel(previous.status)} → ${statusLabel(next.status)}"
        val step = next.plan.find { it.id == next.currentStepId }?.title
        return TaskNotice(
            "${statusLabel(next.status)} · ${next.title}",
            transition,
            listOfNotNull(transition, next.title, step?.let { "当前步骤：$it" }).joinToString("\n"),
            silent,
        )
    }
}
