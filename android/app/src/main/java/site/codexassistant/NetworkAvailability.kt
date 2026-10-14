package site.codexassistant

/** activeNetwork 只代表系统选出的默认网络；门户认证或本地回环验收期间，默认网络可能 暂时为空，但系统仍报告已建立的链路。实际能否同步由 WebSocket 握手判定。 */
internal fun <T> currentOrConnectedNetwork(active: T?, connected: Array<T>): T? =
    active ?: connected.firstOrNull()
