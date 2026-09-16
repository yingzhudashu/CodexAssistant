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
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** Android 不依赖厂商推送：以前台服务保持唯一 WebSocket， 并在任务状态或当前步骤变化时更新常驻通知，同时发出一次简短本地通知。 */
class SyncForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var collectJob: Job? = null
    private val notices = TaskNotices()
    private val postedTaskIds = linkedSetOf<String>()
    private var processingWakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        getSystemService(NotificationManager::class.java)
            .activeNotifications
            .filter { it.id == 0 && it.tag != null }
            .sortedBy { it.postTime }
            .forEach { postedTaskIds.add(it.tag) }
        val coordinator = (application as CodexAssistantApplication).sync
        try {
            startForegroundCompat(baseNotification("正在同步 Codex 任务"))
        } catch (_: IllegalStateException) {
            coordinator.serviceUnavailable()
            stopSelf()
            return
        } catch (_: SecurityException) {
            coordinator.serviceUnavailable()
            stopSelf()
            return
        }
        processingWakeLock =
            getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CodexAssistant:notification")
                .apply { setReferenceCounted(false) }
        val delivery =
            NotificationDelivery(
                scope,
                postTask = postTask@{ change ->
                        if (change.connectionEpoch != coordinator.state().value.connectionEpoch)
                            return@postTask
                        coordinator.traceLogger.span(
                            "android.sync.notification_post",
                            change.traceId,
                        ) {
                            notifyChange(change.previous, change.task)
                        }
                        coordinator.traceLogger.timing(
                            "android.sync.notification_delivery",
                            change.traceId,
                            (android.os.SystemClock.elapsedRealtime() - change.receivedAt)
                                .coerceAtLeast(0),
                        )
                        coordinator.uploadTrace()
                        coordinator.acknowledgeNotification(
                            change.connectionEpoch,
                            change.task.id,
                            change.revision,
                        )
                    },
                postSummary = { updateNotification(it.text) },
                reset = {
                    val manager = getSystemService(NotificationManager::class.java)
                    postedTaskIds.forEach { manager.cancel(it, 0) }
                    postedTaskIds.clear()
                    notices.retain(emptySet())
                },
                workChanged = { pending ->
                    // 只覆盖已收到事件的短时通知处理，不以永久CPU锁保活或绕过Doze网络限制。
                    processingWakeLock?.let { wake ->
                        if (pending) wake.acquire(10_000L) else if (wake.isHeld) wake.release()
                    }
                },
            )
        coordinator.serviceStarted(this)
        collectJob = scope.launch {
            coordinator.state().collect(delivery::update)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (collectJob == null) return START_NOT_STICKY
        (application as CodexAssistantApplication).sync.serviceStarted(this)
        return START_STICKY
    }

    override fun onDestroy() {
        collectJob?.cancel()
        scope.cancel()
        processingWakeLock?.let { if (it.isHeld) it.release() }
        processingWakeLock = null
        (application as CodexAssistantApplication).sync.serviceStopped(this)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                SYNC_CHANNEL_ID,
                "CodexAssistant 同步",
                NotificationManager.IMPORTANCE_LOW,
            )
        )
        manager.createNotificationChannel(
            NotificationChannel(
                EVENT_CHANNEL_ID,
                "CodexAssistant 任务变化",
                NotificationManager.IMPORTANCE_DEFAULT,
            )
        )
    }

    private fun baseNotification(
        text: String,
        channelId: String,
        ongoing: Boolean,
        autoCancel: Boolean,
    ): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pending =
            PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        return NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("CodexAssistant")
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(ongoing)
            .setAutoCancel(autoCancel)
            .setOnlyAlertOnce(ongoing)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setCategory(
                if (ongoing) NotificationCompat.CATEGORY_SERVICE
                else NotificationCompat.CATEGORY_STATUS
            )
            .build()
    }

    private fun baseNotification(text: String): Notification =
        baseNotification(text, SYNC_CHANNEL_ID, ongoing = true, autoCancel = false)

    private fun startForegroundCompat(notification: Notification) {
        // 长期即时通知订阅使用声明了具体用途的specialUse；不是有结束期限的数据传输任务。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        else startForeground(NOTIFICATION_ID, notification)
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, baseNotification(text))
    }

    private fun notifyChange(previousTask: TaskSnapshot?, task: TaskSnapshot) {
        val notice = notices.change(previousTask, task, android.os.SystemClock.elapsedRealtime())
        val intent = Intent(this, MainActivity::class.java)
        val pending =
            PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val notification =
            NotificationCompat.Builder(this, EVENT_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(notice.title)
                .setContentText(notice.text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(notice.detail))
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(
                    baseNotification(
                        "任务状态：${statusLabel(task.status)}",
                        EVENT_CHANNEL_ID,
                        ongoing = false,
                        autoCancel = true,
                    )
                )
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setSilent(notice.silent)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build()
        // tag 使用完整任务 ID，避免 hashCode 碰撞或覆盖常驻通知。
        val manager = getSystemService(NotificationManager::class.java)
        // Android限制每个应用的活动通知总量。为常驻和系统分组留余量，保留最近40个任务。
        // 超额时移除最旧提醒，业务任务仍完整保存在列表中，不能让系统拒绝最新提醒。
        if (task.id !in postedTaskIds)
            while (postedTaskIds.size >= 40) {
                val oldest = postedTaskIds.first()
                manager.cancel(oldest, 0)
                postedTaskIds.remove(oldest)
            }
        manager.notify(task.id, 0, notification)
        postedTaskIds.remove(task.id)
        postedTaskIds.add(task.id)
        notices.retain(postedTaskIds)
    }

    companion object {
        private const val SYNC_CHANNEL_ID = "codex-sync"
        private const val EVENT_CHANNEL_ID = "codex-task-events"
        private const val NOTIFICATION_ID = 1001
    }
}
