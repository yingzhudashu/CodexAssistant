package site.codexassistant

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

private val CodexLight = lightColorScheme(primary=Color(0xFF2457A6), onPrimary=Color.White,
    primaryContainer=Color(0xFFE6F0FF), background=Color(0xFFF3F6FB), surface=Color.White,
    onSurface=Color(0xFF17212B), onSurfaceVariant=Color(0xFF52616E), outline=Color(0xFF7B8A98))
private val CodexDark = darkColorScheme(primary=Color(0xFF2457A6), onPrimary=Color.White,
    primaryContainer=Color(0xFF293E54), background=Color(0xFF111820), surface=Color(0xFF1B2632),
    onSurface=Color(0xFFF1F5F9), onSurfaceVariant=Color(0xFFBCC8D5), outline=Color(0xFF65768A))
private var appearance by mutableStateOf("system")
@Composable fun CodexTheme(content: @Composable () -> Unit) {
    val prefs = LocalContext.current.getSharedPreferences("codex_appearance", 0)
    LaunchedEffect(Unit) { appearance=prefs.getString("theme", "system") ?: "system" }
    val dark=appearance=="dark" || (appearance=="system" && isSystemInDarkTheme())
    MaterialTheme(colorScheme=if(dark) CodexDark else CodexLight,
        shapes=Shapes(small=RoundedCornerShape(8.dp),medium=RoundedCornerShape(12.dp),large=RoundedCornerShape(20.dp)),content=content)
}
@Composable fun CodexScreen(credentials: CredentialStore) {
    val context=LocalContext.current
    val workspaceState = rememberSaveableStateHolder()
    val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    var configured by remember { mutableStateOf(credentials.token()!=null) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var token by remember { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf(credentials.serverBaseUrl()) }
    var error by remember { mutableStateOf<String?>(null) }
    var discard by remember { mutableStateOf(false) }
    fun cancel() { if(token.isNotEmpty() || url!=credentials.serverBaseUrl()) discard=true else editing=false }
    if(configured && editing && !keyboardOpen) BackHandler { cancel() }
    if(!configured || editing) {
        var reveal by remember { mutableStateOf(false) }
        Surface(Modifier.fillMaxSize()) {
            Box(Modifier.safeDrawingPadding().imePadding(),contentAlignment=Alignment.TopCenter) {
                Column(Modifier.widthIn(max=480.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
                    Text("CodexAssistant",style=MaterialTheme.typography.headlineMedium)
                    Text(if(configured) "编辑连接" else "首次连接",style=MaterialTheme.typography.titleLarge)
                    Text("查看工作站任务进度、回合摘要，继续发送消息。")
                    OutlinedTextField(url,{url=it;error=null},Modifier.fillMaxWidth(),label={Text("服务地址")},singleLine=true,supportingText={Text("HTTPS 根地址；本机调试支持回环 HTTP")})
                    OutlinedTextField(token,{token=it;error=null},Modifier.fillMaxWidth(),label={Text("访问 Token")},singleLine=true,
                        visualTransformation=if(reveal) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon={TextButton({reveal=!reveal},enabled=token.isNotEmpty()){Text(if(reveal) "隐藏" else "显示")}},
                        supportingText={Text("16–4096 字符，已有令牌不会回填")})
                    error?.let { Text(it,color=MaterialTheme.colorScheme.error) }
                    Button({try {
                        credentials.saveConnection(url,token)
                        configured=true;editing=false;token=""
                        (context.applicationContext as CodexAssistantApplication).sync.restart()
                        ContextCompat.startForegroundService(context,Intent(context,SyncForegroundService::class.java))
                    } catch(e:Exception) { error=e.message ?: "无法保存连接" }},enabled=token.length in 16..4096,modifier=Modifier.fillMaxWidth()){Text("保存并连接")}
                    if(configured) TextButton({cancel()}){Text("取消")}
                }
            }
        }
    } else {
        val vm:CodexViewModel=viewModel(factory=CodexViewModelFactory(context.applicationContext as CodexAssistantApplication))
        val state by vm.state.collectAsState()
        workspaceState.SaveableStateProvider("workspace") {
            TaskHome(vm,state,credentials){url=credentials.serverBaseUrl();token="";editing=true}
        }
    }
    if(discard) AlertDialog(onDismissRequest={discard=false},title={Text("放弃未保存内容？")},text={Text("本次连接修改会被丢弃。")},
        confirmButton={TextButton({discard=false;editing=false;token="";url=credentials.serverBaseUrl()}){Text("放弃修改")}},dismissButton={TextButton({discard=false}){Text("继续编辑")}})
}
private fun openDownload(context:android.content.Context,url:String?) {
    if(url?.startsWith("https://",true)==true) context.startActivity(Intent(Intent.ACTION_VIEW,android.net.Uri.parse(url)))
}
@Composable private fun NavIcon(settings:Boolean) {
    Canvas(Modifier.size(20.dp)) {
        val c=Color(0xFF7B8A98)
        if(settings) drawCircle(c,style=androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
        else for(i in 0..2) drawLine(c,androidx.compose.ui.geometry.Offset(2.dp.toPx(),(4+i*6).dp.toPx()),androidx.compose.ui.geometry.Offset(18.dp.toPx(),(4+i*6).dp.toPx()),2.dp.toPx())
    }
}
@Composable private fun TaskHome(vm:CodexViewModel,state:TaskState,credentials:CredentialStore,onEditConnection:()->Unit) {
    var page by rememberSaveable { mutableStateOf("tasks") }
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("all") }
    val selected=state.tasks.find{it.id==selectedId}
    val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    BackHandler(!keyboardOpen && (page!="tasks" || selectedId!=null)) {
        when {
            selectedId != null -> { vm.closeDetail(selectedId!!); selectedId = null }
            else -> page = parentPage(page)
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
        val rail=maxWidth>=600.dp
        val dual=maxWidth>=840.dp
        val primaryPage = showPrimaryNavigation(page, selectedId, keyboardOpen)
        Scaffold(bottomBar={if(!rail && primaryPage) NavigationBar {
            listOf("tasks" to "任务","settings" to "设置").forEach{(id,title)->NavigationBarItem(selected=if(id=="tasks") page==id else page!="tasks",onClick={page=id},icon={NavIcon(id!="tasks")},label={Text(title)})}
        }}) { insets ->
            Row(Modifier.fillMaxSize().padding(insets)) {
                if(rail && primaryPage) NavigationRail(Modifier.width(80.dp)) {
                    listOf("tasks" to "任务","settings" to "设置").forEach{(id,title)->NavigationRailItem(selected=page==id,onClick={page=id},icon={NavIcon(id!="tasks")},label={Text(title)})}
                }
                if(page!="tasks") SettingsPage(page,{page=it},state,credentials,onEditConnection,Modifier.weight(1f))
                else {
                    if(dual || selected==null) LazyColumn(Modifier.then(if(dual) Modifier.width(320.dp) else Modifier.weight(1f)).fillMaxHeight(),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                        item { Text("任务工作台",style=MaterialTheme.typography.headlineSmall);Text(connectionStatusLabel(state.connectionStatus),color=MaterialTheme.colorScheme.onSurfaceVariant) }
                        item { OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),label={Text("搜索任务或项目")},singleLine=true) }
                        item { Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            taskStatusFilters.forEach{(id,label)->FilterChip(filter==id,{filter=id},label={Text(label)})}
                        } }
                        state.error?.let{item{Text(it,color=MaterialTheme.colorScheme.error);TextButton(onEditConnection){Text("编辑连接")}}}
                        if(!state.connected && state.tasks.isEmpty()) item{Text("等待同步任务；连接恢复后自动更新。")}
                        val rows=state.tasks.filter{(filter=="all"||canonicalTaskStatus(it.status)==filter)&&(query.isBlank()||"${it.title} ${it.projectName.orEmpty()}".contains(query,true))}
                        if(state.connected && rows.isEmpty()) item{Text(if(query.isBlank()&&filter=="all") "暂无任务，在工作站开始任务后会显示在这里。" else "没有匹配任务，请调整搜索或筛选。")}
                        items(rows,key={it.id}){task->TaskCard(task,task.id==selectedId){selectedId?.let(vm::closeDetail);selectedId=task.id;vm.loadDetail(task.id)}}
                    }
                    if(selected!=null) TaskDetail(vm,selected,state,Modifier.weight(1f)){vm.closeDetail(selected.id);selectedId=null}
                    else if(dual) Box(Modifier.weight(1f).fillMaxHeight(),contentAlignment=Alignment.Center){Text("选择任务查看详情")}
                }
            }
        }
    }
}
@Composable private fun TaskCard(task:TaskSnapshot,selected:Boolean,onClick:()->Unit) {
    OutlinedCard(onClick=onClick,modifier=Modifier.fillMaxWidth(),colors=CardDefaults.outlinedCardColors(containerColor=if(selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text(task.title,style=MaterialTheme.typography.titleMedium,maxLines=2)
            Text(statusLabel(task.status));task.projectName?.let{Text(it,style=MaterialTheme.typography.bodySmall)}
            if(task.plan.isNotEmpty()) {val done=task.plan.count{it.status=="completed"};Text("$done / ${task.plan.size} 步骤");LinearProgressIndicator(progress={done.toFloat()/task.plan.size},modifier=Modifier.fillMaxWidth())}
            Text("${freshnessLabel(task.freshness)} · ${formatTime(task.updatedAt)}",style=MaterialTheme.typography.labelSmall)
        }
    }
}
@Composable private fun TaskDetail(vm:CodexViewModel,task:TaskSnapshot,state:TaskState,modifier:Modifier,close:()->Unit) {
    var tab by rememberSaveable(task.id){mutableIntStateOf(0)}
    var draft by rememberSaveable(task.id){mutableStateOf("")}
    val request=state.sending[task.id]
    val result=state.results[task.id]
    val detail=state.details[task.id]
    Column(modifier.fillMaxHeight().imePadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        TextButton(close){Text("返回任务列表")}
        Text(task.title,style=MaterialTheme.typography.headlineSmall)
        Text("${statusLabel(task.status)} · ${freshnessLabel(task.freshness)}")
        Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            listOf("执行计划","回合摘要","发送消息").forEachIndexed{i,label->FilterChip(tab==i,{tab=i},label={Text(label)})}
        }
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            if(tab==0) {
                item{Text("任务概览",style=MaterialTheme.typography.titleMedium);HorizontalDivider()}
                task.goal?.let{item{Text(it.objective);Text("Token ${it.tokensUsed}${it.tokenBudget?.let{b->" / $b"}?:""} · ${it.timeUsedSeconds} 秒")}}
                task.error?.let{item{Text(it.message,color=MaterialTheme.colorScheme.error)}}
                if(task.activeFlags.contains("waitingOnApproval")) item{Text("请在工作站处理审批")}
                if(task.activeFlags.contains("waitingOnUserInput")) item{Text("等待补充信息，可在发送消息中回复")}
                if(task.plan.isEmpty()) item{Text("此任务未提供执行计划")}
                items(task.plan,key={it.id}){step->OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp)){Text(step.title);Text(mapOf("pending" to "待开始","in_progress" to "执行中","completed" to "完成","failed" to "失败")[step.status]?:step.status)}}}
                item{Text("状态变化：${formatTime(task.changedAt)}",style=MaterialTheme.typography.bodySmall)}
            } else if(tab==1) {
                item{Text("回合摘要",style=MaterialTheme.typography.titleMedium);HorizontalDivider()}
                if(task.id in state.loadingDetails) item{LinearProgressIndicator(Modifier.fillMaxWidth());Text("正在读取回合…")}
                state.detailErrors[task.id]?.let{item{Text(it,color=MaterialTheme.colorScheme.error);TextButton({vm.loadDetail(task.id)}){Text("重试读取")}}}
                if(detail?.turns?.isEmpty()==true) item{Text("暂无回合摘要")}
                items(detail?.turns ?: emptyList()){turn->OutlinedCard(Modifier.fillMaxWidth()){Text(readableTurn(turn),Modifier.padding(12.dp))}}
                detail?.cursor?.let{cursor->item{OutlinedButton({vm.loadDetail(task.id,cursor)},enabled=task.id !in state.loadingDetails && state.connected){Text("加载更早回合")}}}
            } else {
                item{Text("发送消息",style=MaterialTheme.typography.titleMedium);HorizontalDivider()}
                item{Text("消息由已连接的工作站处理。工作站审批需在工作站完成。")}
                if(!state.connected) item{Text("连接不可用，草稿保留，恢复连接后可发送。",color=MaterialTheme.colorScheme.error)}
                item{OutlinedTextField(draft,{draft=it},Modifier.fillMaxWidth(),label={Text("消息")},minLines=3,maxLines=8,supportingText={Text("${draft.length} / 20000")},isError=draft.length>20000)}
                item{Button({vm.send(task.id,draft)},enabled=state.connected && request==null && draft.trim().length in 1..20000,modifier=Modifier.fillMaxWidth()){Text(if(request!=null) "等待工作站回执…" else "发送消息")}}
                result?.let{item{Text(it.error?:it.text?:mapOf("started" to "已接受，回合仍在执行","streaming" to "正在生成","completed" to "回合已完成","failed" to "发送失败")[it.status]?:it.status,color=if(it.status=="failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)}}
            }
        }
    }
    LaunchedEffect(result?.requestId,result?.status){if(result?.status in listOf("started","completed")) draft=""}
}
private fun readableTurn(turn:JsonElement):String {
    val obj=turn as? JsonObject ?: return "此内容请在工作站查看"
    val status=(obj["status"] as? JsonPrimitive)?.contentOrNull
    val content=(obj["items"] as? JsonArray)?.mapNotNull{item->val o=item as? JsonObject
        if((o?.get("type") as? JsonPrimitive)?.contentOrNull in listOf("userMessage","agentMessage","assistantMessage")) {
            (o?.get("text") as? JsonPrimitive)?.contentOrNull ?: (o?.get("content") as? JsonArray)?.mapNotNull{(it as? JsonObject)?.get("text")?.jsonPrimitive?.contentOrNull}?.joinToString("\n")
        } else null }?.joinToString("\n\n")
    return listOfNotNull(status?.let{mapOf("inProgress" to "进行中","completed" to "回合完成","interrupted" to "回合中断","failed" to "回合失败")[it]?:it},content?.takeIf{it.isNotBlank()}?:"此内容请在工作站查看").joinToString("\n")
}
@Composable private fun SettingsPage(page:String,navigate:(String)->Unit,state:TaskState,credentials:CredentialStore,edit:()->Unit,modifier:Modifier) {
    val context=LocalContext.current
    var update by remember{mutableStateOf<UpdateInfo?>(null)}
    var error by remember{mutableStateOf<String?>(null)}
    var checking by remember{mutableStateOf(false)}
    val scope=rememberCoroutineScope()
    LazyColumn(modifier.fillMaxHeight(),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
        item{Text(if(page=="settings") "设置" else mapOf("connection" to "连接与诊断","appearance" to "外观","notifications" to "通知","about" to "关于与更新")[page]?:"设置",style=MaterialTheme.typography.headlineSmall)}
        if(page!="settings") item{TextButton({navigate("settings")}){Text("返回设置")}}
        when(page) {
            "settings"->items(listOf("connection" to "连接与诊断","notifications" to "通知","appearance" to "外观","about" to "关于与更新")){(id,title)->OutlinedCard(onClick={navigate(id)},modifier=Modifier.fillMaxWidth()){Text(title,Modifier.padding(20.dp))}}
            "connection"->{item{Text(connectionStatusLabel(state.connectionStatus));Text(credentials.serverBaseUrl());Text("重连次数：${state.retryAttempt}");state.error?.let{Text(it,color=MaterialTheme.colorScheme.error)};Button(edit){Text("编辑连接")}};item{Text("同步游标：${state.cursor}");Text("最近连接：${state.lastConnectedAtEpochMs?.let{java.util.Date(it).toString()}?:"未连接"}");Text("诊断标识：${state.lastTraceId?:"未提供"}")}}
            "appearance"->items(listOf("system" to "跟随系统","light" to "浅色","dark" to "深色")){(id,title)->Row(Modifier.fillMaxWidth().clickable{appearance=id;context.getSharedPreferences("codex_appearance",0).edit().putString("theme",id).apply()},verticalAlignment=Alignment.CenterVertically){RadioButton(appearance==id,{appearance=id;context.getSharedPreferences("codex_appearance",0).edit().putString("theme",id).apply()});Text(title)}}
            "notifications"->item{Text(if(androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) "系统通知已允许" else "系统通知未允许，同步连接仍可正常工作");Text("任务通知与前台同步使用独立渠道。锁屏隐藏任务正文。");Button({context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,context.packageName))}){Text("打开系统通知设置")}}
            "about"->item{Text("CodexAssistant ${BuildConfig.VERSION_NAME}");Text("Windows 工作站与 Android 任务助手");Button({checking=true;error=null;scope.launch{try{update=UpdateChecker().check(credentials.serverBaseUrl())}catch(e:CancellationException){throw e}catch(e:Exception){error="无法检查更新，请检查网络后重试"}finally{checking=false}}},enabled=!checking){Text(if(checking) "检查中…" else "检查更新")};error?.let{Text(it,color=MaterialTheme.colorScheme.error)};update?.let{u->Text(if(u.versionCode>BuildConfig.VERSION_CODE) "发现新版本 ${u.version}" else "当前无需更新");if(u.versionCode>BuildConfig.VERSION_CODE) TextButton({openDownload(context,u.androidUrl)}){Text("下载 Android")};u.windowsUrl?.let{url->TextButton({openDownload(context,url)}){Text("下载 Windows")}}};Text("下载在系统浏览器打开，安装需手动确认。")}
        }
    }
}
private fun connectionStatusLabel(status:String)=mapOf("connecting" to "连接中","authenticating" to "认证中","subscribing" to "同步中","connected" to "已连接","reconnecting" to "重连中","offline" to "网络离线","auth_failed" to "认证失败","protocol_error" to "协议错误","not_configured" to "未配置")[status]?:status
private fun freshnessLabel(value:String)=mapOf("fresh" to "近期采集","stale" to "缓存","unavailable" to "无法采集")[value]?:value

private class CodexViewModelFactory(private val application: CodexAssistantApplication) : androidx.lifecycle.ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = CodexViewModel(application.sync) as T
}
