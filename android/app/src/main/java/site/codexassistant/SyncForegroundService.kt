package site.codexassistant

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel

/**
 * Android 不依赖厂商推送：以前台服务保持唯一 WebSocket，
 * 并在任务状态或当前步骤变化时更新常驻通知，同时发出一次简短本地通知。
 */
class SyncForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var collectJob: Job? = null
    private var previous = emptyMap<String, TaskSnapshot>()
    private val lastNotificationAt = mutableMapOf<String, Long>()

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForegroundCompat(baseNotification("正在同步 Codex 任务"))
        val coordinator = (application as CodexAssistantApplication).sync
        coordinator.start()
        collectJob = scope.launch {
            coordinator.state().collectLatest { state ->
                val current = state.tasks.associateBy { it.id }
                // 一次服务端回放可能包含同一任务的多次变化。每个任务十秒内只提醒一次，
                // 仍会更新同一通知 ID 的最终状态，避免恢复游标时产生通知轰炸。
                current.values.filter { next ->
                    val old = previous[next.id]
                    old != null && (old.status != next.status || old.currentStepId != next.currentStepId)
                }.forEach(::notifyChange)
                lastNotificationAt.keys.retainAll(current.keys)
                previous = current
                val summary = current.values.count { it.status in setOf("active", "waiting", "blocked", "paused") }
                updateNotification(
                    when {
                        state.connected -> "同步中 · $summary 个进行中任务"
                        state.error != null -> "连接中断，正在等待重连"
                        else -> "正在连接 Codex 任务"
                    },
                )
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        collectJob?.cancel()
        scope.cancel()
        (application as CodexAssistantApplication).sync.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(SYNC_CHANNEL_ID, "CodexAssistant 同步", NotificationManager.IMPORTANCE_LOW))
            manager.createNotificationChannel(NotificationChannel(EVENT_CHANNEL_ID, "CodexAssistant 任务变化", NotificationManager.IMPORTANCE_DEFAULT))
        }
    }

    private fun baseNotification(text: String, channelId: String, ongoing: Boolean, autoCancel: Boolean): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("CodexAssistant")
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(ongoing)
            .setAutoCancel(autoCancel)
            .setOnlyAlertOnce(ongoing)
            .setCategory(if (ongoing) NotificationCompat.CATEGORY_SERVICE else NotificationCompat.CATEGORY_STATUS)
            .build()
    }

    private fun baseNotification(text: String): Notification = baseNotification(text, SYNC_CHANNEL_ID, ongoing = true, autoCancel = false)

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(NOTIFICATION_ID, notification)
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, baseNotification(text))
    }

    private fun notifyChange(task: TaskSnapshot) {
        val now = System.currentTimeMillis()
        val last = lastNotificationAt[task.id]
        if (last != null && now - last < NOTIFICATION_THROTTLE_MS) return
        lastNotificationAt[task.id] = now
        val step = task.currentStepId?.let { id -> task.plan.find { it.id == id }?.title }
        val text = listOf(statusLabel(task.status), step).filterNotNull().joinToString(" · ")
        val notification = baseNotification("${task.title} · $text", EVENT_CHANNEL_ID, ongoing = false, autoCancel = true)
        getSystemService(NotificationManager::class.java).notify(task.id.hashCode(), notification)
    }

    private fun statusLabel(status: String): String = mapOf("active" to "进行中", "paused" to "已暂停", "blocked" to "已阻塞", "waiting" to "等待中", "complete" to "已完成", "failed" to "失败")[status] ?: status

    companion object {
        private const val SYNC_CHANNEL_ID = "codex-sync"
        private const val EVENT_CHANNEL_ID = "codex-task-events"
        private const val NOTIFICATION_ID = 1001
        private const val NOTIFICATION_THROTTLE_MS = 10_000L
    }
}
