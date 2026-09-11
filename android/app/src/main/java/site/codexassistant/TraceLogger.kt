package site.codexassistant

import android.util.Log
import java.time.Instant
import java.util.UUID
import kotlin.math.max

/** Android 端的轻量 trace 记录器：只缓存 span 名称、ID 和耗时，绝不记录 Token 或任务正文。 */
class TraceLogger(private val log: (String) -> Unit = { Log.d("CodexAssistantTrace", it); Unit }) {
    private val pending = LinkedHashMap<String, TraceSpan>()
    private val lastSpanByTrace = mutableMapOf<String, String>()

    fun newTraceId(): String = UUID.randomUUID().toString().replace("-", "").take(32)

    fun <T> span(name: String, traceId: String = newTraceId(), block: () -> T): T {
        val started = System.nanoTime()
        return try {
            block()
        } finally {
            val elapsedMs = max(0L, (System.nanoTime() - started) / 1_000_000)
            record(name, traceId, elapsedMs)
        }
    }

    fun event(name: String, traceId: String = newTraceId()) {
        record(name, traceId, 0)
    }

    @Synchronized fun pending(limit: Int = 100): List<TraceSpan> = pending.values.take(limit)

    @Synchronized fun acknowledge(spanIds: Set<String>) {
        spanIds.forEach(pending::remove)
    }

    private fun record(name: String, traceId: String, durationMs: Long) {
        val spanId = UUID.randomUUID().toString().replace("-", "").take(16)
        val ended = Instant.now()
        val started = ended.minusMillis(durationMs)
        val parentSpanId = synchronized(this) { lastSpanByTrace[traceId] }
        val span = TraceSpan(traceId, spanId, parentSpanId, name = name.take(80), startedAt = started.toString(), endedAt = ended.toString(), attributes = mapOf("latencyMs" to durationMs.toString()))
        synchronized(this) {
            pending[spanId] = span
            lastSpanByTrace[traceId] = spanId
            while (pending.size > 100) pending.remove(pending.keys.first())
        }
        log("span=${span.name} traceId=$traceId durationMs=$durationMs")
    }
}
