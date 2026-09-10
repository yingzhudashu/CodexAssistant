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
    private val notices = TaskNotices()
    private var wasConnected = false

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
                    if (!state.connected || !wasConnected) return@filter false
                    val old = previous[next.id]
                    old != null && (old.status != next.status || old.currentStepId != next.currentStepId)
                }.forEach { next -> notifyChange(previous.getValue(next.id), next) }
                notices.retain(current.keys)
                wasConnected = state.connected
                previous = current
                val summary = current.values.count { it.status == "running" }
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

    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15 ends the data-sync foreground-service allowance.
        // Stop within the system deadline; reopening the app can resume sync.
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

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

    private fun notifyChange(previousTask: TaskSnapshot, task: TaskSnapshot) {
        val notice = notices.change(previousTask, task, android.os.SystemClock.elapsedRealtime())
        val intent = Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, EVENT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.title)
            .setContentText(notice.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.detail))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(baseNotification("任务状态：${statusLabel(task.status)}", EVENT_CHANNEL_ID, ongoing = false, autoCancel = true))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setSilent(notice.silent)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        // tag 使用完整任务 ID，避免 hashCode 碰撞或覆盖常驻通知。
        getSystemService(NotificationManager::class.java).notify(task.id, 0, notification)
    }

    companion object {
        private const val SYNC_CHANNEL_ID = "codex-sync"
        private const val EVENT_CHANNEL_ID = "codex-task-events"
        private const val NOTIFICATION_ID = 1001
    }
}
