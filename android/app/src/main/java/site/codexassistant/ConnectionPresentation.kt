package site.codexassistant

internal fun connectionStatusLabel(status: String): String = when(status) {
    "connecting" -> "连接中"
    "authenticating" -> "认证中"
    "subscribing" -> "同步中"
    "connected" -> "已连接"
    "reconnecting" -> "正在恢复连接"
    "offline" -> "同步已停止"
    "auth_failed" -> "认证失败"
    "protocol_error" -> "协议错误"
    "not_configured" -> "未配置"
    else -> "连接状态未知"
}

internal fun connectionSummary(state: TaskState): String = when {
    state.connectionStatus == "offline" && state.networkAvailable == false -> "等待网络恢复"
    state.connectionStatus == "reconnecting" -> "正在恢复连接 · 第${state.retryAttempt}次尝试"
    else -> connectionStatusLabel(state.connectionStatus)
}

internal fun backgroundSyncSummary(state: TaskState): String = when(state.backgroundSyncStatus) {
    "running" -> "后台同步服务运行中"
    "unavailable" -> "后台同步暂不可用，当前页面仍可同步"
    else -> "后台同步服务未运行"
}
