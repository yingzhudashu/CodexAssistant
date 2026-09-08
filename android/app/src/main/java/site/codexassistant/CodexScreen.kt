package site.codexassistant

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.AssistChip
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import android.content.Intent
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException

@Composable
fun CodexTheme(content: @Composable () -> Unit) { MaterialTheme(content = content) }

@Composable
fun CodexScreen(credentials: CredentialStore) {
    val context = LocalContext.current
    var token by remember { mutableStateOf(credentials.token().orEmpty()) }
    var apiUrl by remember { mutableStateOf(credentials.apiUrl()) }
    var configured by remember { mutableStateOf(credentials.token() != null) }
    var editingConnection by remember { mutableStateOf(false) }
    var connectionError by remember { mutableStateOf<String?>(null) }
    if (!configured || editingConnection) {
        ConnectionForm(apiUrl, token, connectionError, configured, onUrlChange = { apiUrl = it; connectionError = null }, onTokenChange = { token = it; connectionError = null }) {
            try {
                credentials.saveApiUrl(apiUrl)
                credentials.save(token)
                (context.applicationContext as CodexAssistantApplication).sync.restart()
                ContextCompat.startForegroundService(context, Intent(context, SyncForegroundService::class.java))
                configured = true
                editingConnection = false
            } catch (error: IllegalArgumentException) {
                connectionError = error.message ?: "连接配置无效"
            }
        }
    } else {
        val vm: CodexViewModel = viewModel(factory = CodexViewModelFactory(context.applicationContext as CodexAssistantApplication))
        TaskHome(vm.state.collectAsState().value, credentials, onEditConnection = { editingConnection = true })
    }
}

@Composable
private fun ConnectionForm(url: String, token: String, error: String?, isEditing: Boolean, onUrlChange: (String) -> Unit, onTokenChange: (String) -> Unit, onConnect: () -> Unit) {
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.statusBarsPadding().navigationBarsPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("CodexAssistant", style = MaterialTheme.typography.headlineMedium)
            Text("连接你的 Codex 任务进度", color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(url, onUrlChange, label = { Text("服务地址") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(token, onTokenChange, label = { Text("访问 Token") }, modifier = Modifier.fillMaxWidth(), singleLine = true, visualTransformation = PasswordVisualTransformation())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = onConnect, enabled = token.length >= 16 && url.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text(if (isEditing) "保存并重连" else "连接") }
        }
    }
}

private fun openDownload(context: android.content.Context, url: String?) {
    if (url.isNullOrBlank() || !url.startsWith("https://", ignoreCase = true)) return
    context.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
}

@Composable
private fun TaskHome(state: TaskState, credentials: CredentialStore, onEditConnection: () -> Unit) {
    var selected by remember { mutableStateOf<TaskSnapshot?>(null) }
    var showAll by remember { mutableStateOf(false) }
    var update by remember { mutableStateOf<UpdateInfo?>(null) }
    var updateError by remember { mutableStateOf<String?>(null) }
    var checkingUpdate by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val updateChecker = remember { UpdateChecker() }
    val active = state.tasks.filter { it.status in setOf("active", "waiting", "blocked", "paused") }
    val recent = state.tasks.filterNot { active.contains(it) }.let { if (showAll) it else it.take(8) }
    Surface(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        LazyColumn(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column { Text("CodexAssistant", style = MaterialTheme.typography.headlineSmall); Text("游标 ${state.cursor}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
                        AssistChip(onClick = {}, label = { Text(connectionStatusLabel(state.connectionStatus)) })
                        TextButton(onClick = onEditConnection) { Text("设置") }
                    }
                }
                state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                Text("${state.tasks.size} 个任务 · 游标 ${state.cursor}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Column(Modifier.weight(1f)) {
                                Text("应用更新", style = MaterialTheme.typography.titleSmall)
                                Text(update?.let { if (it.versionCode > BuildConfig.VERSION_CODE) "发现新版本 ${it.version}" else "已是最新版本 ${BuildConfig.VERSION_NAME}" } ?: "当前版本 ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Button(enabled = !checkingUpdate, onClick = {
                                checkingUpdate = true
                                updateError = null
                                scope.launch {
                                    try { update = updateChecker.check(credentials.serverBaseUrl()) }
                                    catch (error: CancellationException) { throw error }
                                    catch (error: Exception) { updateError = when (error) {
                                        is java.net.UnknownHostException -> "无法解析更新服务器，请检查网络和服务地址"
                                        is java.net.SocketTimeoutException -> "更新请求超时，请稍后重试"
                                        is javax.net.ssl.SSLException -> "更新服务器证书验证失败"
                                        is IllegalArgumentException -> "更新清单格式或协议不正确"
                                        else -> "无法连接更新服务，请检查网络或稍后重试"
                                    } }
                                    finally { checkingUpdate = false }
                                }
                            }) { Text(if (checkingUpdate) "检查中" else "检查更新") }
                        }
                        updateError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                        update?.let { info ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                info.androidUrl?.let { TextButton(onClick = { openDownload(context, it) }) { Text("下载 Android") } }
                                info.windowsUrl?.let { TextButton(onClick = { openDownload(context, it) }) { Text("下载 Windows") } }
                            }
                        }
                    }
                }
            }
            item { SectionTitle("进行中的任务") }
            items(active, key = { it.id }) { task -> TaskCard(task) { selected = task } }
            item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { SectionTitle("最近变化"); TextButton(onClick = { showAll = !showAll }) { Text(if (showAll) "收起" else "全部") } } }
            items(recent, key = { it.id }) { task -> TaskCard(task) { selected = task } }
            selected?.let { task -> item { TaskDetail(task) } }
        }
    }
}

@Composable private fun SectionTitle(text: String) { Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary) }

@Composable
private fun TaskCard(task: TaskSnapshot, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(task.title, style = MaterialTheme.typography.titleMedium, maxLines = 2)
            val done = task.plan.count { it.status == "completed" }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(statusLabel(task.status), color = statusColor(task.status)); Text("$done/${task.plan.size} 步骤") }
            if (task.plan.isNotEmpty()) LinearProgressIndicator(progress = { done.toFloat() / task.plan.size.coerceAtLeast(1) }, modifier = Modifier.fillMaxWidth())
            task.currentStepId?.let { id -> task.plan.find { it.id == id }?.let { Text(it.title, maxLines = 1, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            Text("任务更新：${formatTime(task.updatedAt)} · ${freshnessLabel(task.freshness)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun connectionStatusLabel(status: String): String = mapOf("connecting" to "连接中", "authenticating" to "认证中", "subscribing" to "同步中", "connected" to "已连接", "reconnecting" to "重连中", "offline" to "网络离线", "auth_failed" to "认证失败", "protocol_error" to "协议错误", "not_configured" to "未配置")[status] ?: status
private fun freshnessLabel(value: String): String = mapOf("fresh" to "实时", "stale" to "缓存", "unavailable" to "不可用")[value] ?: value
@Composable private fun statusColor(status: String) = when (status) { "failed", "blocked" -> MaterialTheme.colorScheme.error; "waiting", "paused" -> MaterialTheme.colorScheme.tertiary; "complete" -> MaterialTheme.colorScheme.secondary; else -> MaterialTheme.colorScheme.primary }

@Composable
private fun TaskDetail(task: TaskSnapshot) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("任务详情", style = MaterialTheme.typography.titleMedium)
            Text("状态变化：${formatTime(task.changedAt)}", style = MaterialTheme.typography.bodySmall)
            task.goal?.let { Text("目标：${it.objective}"); Text("Token ${it.tokensUsed}${it.tokenBudget?.let { budget -> "/$budget" } ?: ""} · ${it.timeUsedSeconds}s") }
            Text("线程：${task.runtimeStatus} · ${task.freshness}", style = MaterialTheme.typography.bodySmall)
            task.activeFlags.takeIf { it.isNotEmpty() }?.let { Text("等待：${it.joinToString("、")}", color = MaterialTheme.colorScheme.tertiary) }
            task.latestTurn?.let { turn -> Text("最近回合：${turn.status}${turn.durationMs?.let { " · ${it}ms" } ?: ""}") }
            task.latestTurn?.startedAt?.let { Text("回合开始：${formatTime(it)}", style = MaterialTheme.typography.bodySmall) }
            task.latestTurn?.completedAt?.let { Text("回合结束：${formatTime(it)}", style = MaterialTheme.typography.bodySmall) }
            task.error?.let { Text("错误：${it.message}", color = MaterialTheme.colorScheme.error) }
            task.plan.forEach { Text("${if (it.status == "completed") "✓" else "•"} ${it.title}") }
        }
    }
}

private class CodexViewModelFactory(private val application: CodexAssistantApplication) : androidx.lifecycle.ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = CodexViewModel(application.sync) as T
}
