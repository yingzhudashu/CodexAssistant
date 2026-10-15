package site.codexassistant

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/** 返回系统设置后立即重新读取授权，不能用按钮点击本身推断用户已允许后台运行。 */
@Composable
internal fun BackgroundSyncSettings(state: TaskState) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val power = remember(context) { context.getSystemService(PowerManager::class.java) }
    var unrestricted by remember {
        mutableStateOf(power.isIgnoringBatteryOptimizations(context.packageName))
    }
    var deviceIdle by remember { mutableStateOf(power.isDeviceIdleMode) }
    var eventNotificationsEnabled by remember { mutableStateOf(taskNotificationsEnabled(context)) }
    DisposableEffect(owner, power) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                unrestricted = power.isIgnoringBatteryOptimizations(context.packageName)
                deviceIdle = power.isDeviceIdleMode
                eventNotificationsEnabled = taskNotificationsEnabled(context)
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("后台及时提醒", style = MaterialTheme.typography.titleMedium)
        Text(backgroundSyncSummary(state))
        Text("实时连接：${connectionSummary(state)}")
        Text(
            "最近收到任务状态：${state.lastStateReceivedAtEpochMs?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) } ?: "尚未收到"}"
        )
        Text(if (eventNotificationsEnabled) "任务提醒：系统通知和提醒渠道可用" else "任务提醒：权限或提醒渠道已关闭；变化会保留并在允许后重试")
        Text(if (deviceIdle) "系统省电状态：当前处于休眠限制" else "系统省电状态：未处于 Doze")
        Text(if (unrestricted) "电池优化：已允许后台持续连接" else "电池优化：息屏时可能延迟接收")
        Text(
            "本应用通过持续连接接收任务变化。若需息屏及时提醒，请允许不受电池优化限制；部分手机还需在应用管理中允许自启动和后台运行。",
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(oemBackgroundGuidance(), style = MaterialTheme.typography.bodySmall)
        if (!unrestricted) {
            OutlinedButton(
                onClick = {
                    context.startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                            .setData(Uri.parse("package:${context.packageName}"))
                    )
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Text("允许后台持续连接")
            }
        }
        Text("此设置可能增加耗电。系统强行停止或厂商限制仍可能中断同步。", style = MaterialTheme.typography.bodySmall)
    }
}

private fun taskNotificationsEnabled(context: android.content.Context): Boolean {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
    val channel =
        context
            .getSystemService(NotificationManager::class.java)
            .getNotificationChannel(SyncForegroundService.EVENT_CHANNEL_ID)
    return channel != null && channel.importance != NotificationManager.IMPORTANCE_NONE
}

private fun oemBackgroundGuidance(): String =
    when (Build.MANUFACTURER.lowercase()) {
        "xiaomi",
        "redmi",
        "poco" -> "小米/Redmi：可在应用信息中检查自启动，并将电池策略设为无限制。"
        "huawei",
        "honor" -> "华为/Honor：可检查应用启动管理，允许后台活动并关闭自动管理。"
        "oppo",
        "oneplus",
        "realme" -> "OPPO/OnePlus/realme：可检查应用耗电管理和后台运行限制。"
        "vivo",
        "iqoo" -> "vivo/iQOO：可检查后台高耗电和自启动管理。"
        else -> "若息屏后仍中断，请在系统应用管理中允许后台运行/自启动并设置不受限制；菜单名称因系统版本而异。"
    }
