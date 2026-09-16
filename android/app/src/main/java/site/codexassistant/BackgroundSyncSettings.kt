package site.codexassistant

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
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
    DisposableEffect(owner, power) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME)
                unrestricted = power.isIgnoringBatteryOptimizations(context.packageName)
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("后台及时提醒", style = MaterialTheme.typography.titleMedium)
        Text(backgroundSyncSummary(state))
        Text(if (unrestricted) "电池优化：已允许后台持续连接" else "电池优化：息屏时可能延迟接收")
        Text(
            "本应用通过持续连接接收任务变化。若需息屏及时提醒，请允许不受电池优化限制；部分手机还需在应用管理中允许自启动和后台运行。",
            style = MaterialTheme.typography.bodyMedium,
        )
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
