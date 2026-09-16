package site.codexassistant

import android.util.Log
import java.time.Instant
import java.util.UUID
import kotlin.math.max

/** Android 端的轻量 trace 记录器：只缓存 span 名称、ID 和耗时，绝不记录 Token 或任务正文。 */
class TraceLogger(
    private val log: (String) -> Unit = {
        Log.d("CodexAssistantTrace", it)
        Unit
    }
) {
    private val pending = LinkedHashMap<String, TraceSpan>()
    private val lastSpanByTrace = LinkedHashMap<String, String>()
    internal val retainedTraceCount: Int
        get() = synchronized(this) { lastSpanByTrace.size }

    fun newTraceId(): String = UUID.randomUUID().toString().replace("-", "").take(32)

    fun <T> span(
        name: String,
        traceId: String = newTraceId(),
        parentSpanId: String? = null,
        block: () -> T,
    ): T {
        val started = System.nanoTime()
        return try {
            block()
        } finally {
            val elapsedMs = max(0L, (System.nanoTime() - started) / 1_000_000)
            record(name, traceId, elapsedMs, parentSpanId)
        }
    }

    fun event(name: String, traceId: String = newTraceId()) {
        record(name, traceId, 0)
    }

    /** 显式记录队列等待等跨协程耗时，只接受非负时长，不携带任务正文。 */
    fun timing(name: String, traceId: String, durationMs: Long) {
        record(name, traceId, durationMs.coerceAtLeast(0))
    }

    @Synchronized fun pending(limit: Int = 100): List<TraceSpan> = pending.values.take(limit)

    @Synchronized
    fun acknowledge(spanIds: Set<String>) {
        spanIds.forEach(pending::remove)
    }

    private fun record(
        name: String,
        traceId: String,
        durationMs: Long,
        explicitParent: String? = null,
    ) {
        val spanId = UUID.randomUUID().toString().replace("-", "").take(16)
        val ended = Instant.now()
        val started = ended.minusMillis(durationMs)
        val safeName =
            if (name.matches(Regex("android\\.(?:sync|lifecycle|service|refresh)\\.[a-z_]+")))
                name.take(80)
            else "diagnostic"
        synchronized(this) {
            // 父节点读取与新节点写入在同一锁内，防止并发事件错误挂到同一个旧父节点。
            val parentSpanId = explicitParent ?: lastSpanByTrace[traceId]
            val span =
                TraceSpan(
                    traceId,
                    spanId,
                    parentSpanId,
                    name = safeName,
                    startedAt = started.toString(),
                    endedAt = ended.toString(),
                    attributes = mapOf("latencyMs" to durationMs.toString()),
                )
            pending[spanId] = span
            lastSpanByTrace.remove(traceId)
            lastSpanByTrace[traceId] = spanId
            while (pending.size > 100) pending.remove(pending.keys.first())
            while (lastSpanByTrace.size > 100) lastSpanByTrace.remove(lastSpanByTrace.keys.first())
        }
        // 诊断输出本身失败时也必须保留业务返回值。
        runCatching { log("span=$safeName traceId=$traceId durationMs=$durationMs") }
    }
}
