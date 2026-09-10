package site.codexassistant

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable private fun SettingsSection(title: String, subtitle: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp), content = content)
        }
    }
}

@Composable internal fun SettingsPage(page: String, navigate: (String) -> Unit, state: TaskState, credentials: CredentialStore, edit: () -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var update by remember { mutableStateOf<UpdateInfo?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    val titles = mapOf("settings" to "设置", "connection" to "连接与诊断", "notifications" to "通知", "appearance" to "外观", "about" to "关于与更新")
    Surface(modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(contentAlignment = Alignment.TopCenter) {
            LazyColumn(Modifier.widthIn(max = 720.dp).fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                item {
                    if (page != "settings") TextButton({ navigate("settings") }, contentPadding = PaddingValues(0.dp), modifier = Modifier.heightIn(min = 48.dp)) { Text("‹  返回设置") }
                    Text(titles[page] ?: "设置", style = MaterialTheme.typography.headlineMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(if (page == "settings") "管理工作站连接，让移动协作更合心意。" else "CodexAssistant · 设备偏好", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                when (page) {
                    "settings" -> {
                        item {
                            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                                Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text("工作站连接", style = MaterialTheme.typography.labelLarge)
                                    Text(connectionStatusLabel(state.connectionStatus), style = MaterialTheme.typography.headlineSmall)
                                    Text(credentials.serverBaseUrl(), style = MaterialTheme.typography.bodyMedium)
                                    TextButton({ navigate("connection") }) { Text("查看连接与诊断  ›") }
                                }
                            }
                        }
                        item {
                            SettingsSection("设备偏好", "外观立即应用；通知权限由系统管理。") {
                                listOf("appearance" to "浅色、深色或跟随系统", "notifications" to "通知权限与后台同步", "about" to "版本信息与下载更新").forEachIndexed { index, (id, detail) ->
                                    if (index > 0) HorizontalDivider()
                                    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button) { navigate(id) }, verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) { Text(titles.getValue(id), style = MaterialTheme.typography.titleMedium); Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                        Text("›", style = MaterialTheme.typography.headlineSmall)
                                    }
                                }
                            }
                        }
                    }
                    "connection" -> {
                        item { SettingsSection("连接状态", "手机通过此服务与 Windows 工作站同步。") {
                            Text(connectionStatusLabel(state.connectionStatus), style = MaterialTheme.typography.titleLarge)
                            Text(credentials.serverBaseUrl()); state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                            Button(edit, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("编辑连接") }
                        } }
                        item { SettingsSection("同步诊断", "遇到连接问题时，可用以下信息核对同步进度。") {
                            Text("重连次数：${state.retryAttempt}"); Text("同步游标：${state.cursor}")
                            Text("最近连接：${state.lastConnectedAtEpochMs?.let { java.util.Date(it).toString() } ?: "未连接"}")
                            Text("诊断标识：${state.lastTraceId ?: "未提供"}", style = MaterialTheme.typography.bodySmall)
                        } }
                    }
                    "appearance" -> item { SettingsSection("颜色主题", "选择后立即保存，只影响这台设备。") {
                        listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色").forEach { (id, label) ->
                            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.RadioButton) { appearance = id; context.getSharedPreferences("codex_appearance", 0).edit().putString("theme", id).apply() }, verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(appearance == id, onClick = null); Spacer(Modifier.width(12.dp)); Text(label)
                                if (appearance == id) { Spacer(Modifier.weight(1f)); Text("已应用", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary) }
                            }
                        }
                    } }
                    "notifications" -> item { SettingsSection("系统通知", "任务提醒与前台同步使用独立通知渠道。") {
                        Text(if (androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) "通知已允许" else "通知未允许", style = MaterialTheme.typography.titleLarge)
                        Text("锁屏隐藏任务正文。关闭提醒不影响应用内查看同步状态。")
                        OutlinedButton({ context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("打开系统通知设置") }
                    } }
                    "about" -> item { SettingsSection("CodexAssistant", "随时查看进展，继续你的 Codex 会话。") {
                        Text("版本 ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.titleLarge)
                        Button({ checking = true; error = null; scope.launch { try { update = UpdateChecker().check(credentials.serverBaseUrl()) } catch (e: CancellationException) { throw e } catch (_: Exception) { error = "无法检查更新，请检查网络后重试" } finally { checking = false } } }, enabled = !checking, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (checking) "正在检查…" else "检查更新") }
                        if (checking) LinearProgressIndicator(Modifier.fillMaxWidth())
                        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        update?.let { u -> Text(if (u.versionCode > BuildConfig.VERSION_CODE) "发现新版本 ${u.version}" else "当前无需更新")
                            if (u.versionCode > BuildConfig.VERSION_CODE) TextButton({ openDownload(context, u.androidUrl) }) { Text("下载 Android 版本") }
                            u.windowsUrl?.let { url -> TextButton({ openDownload(context, url) }) { Text("下载 Windows 版本") } }
                        }
                        Text("下载将在系统浏览器打开，安装由你手动确认。", style = MaterialTheme.typography.bodySmall)
                    } }
                }
            }
        }
    }
}
