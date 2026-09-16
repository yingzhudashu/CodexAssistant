package site.codexassistant

import org.junit.Assert.*
import org.junit.Test

class TraceLoggerTest {
    @Test
    fun boundsBothQueuesAndKeepsAnExplicitBusinessParent() {
        val logger = TraceLogger {}
        repeat(1000) { logger.event("android.sync.connect") }
        assertEquals(100, logger.pending().size)
        assertEquals(100, logger.retainedTraceCount)
        val traceId = "0123456789abcdef0123456789abcdef"
        val parent = "0123456789abcdef"
        assertEquals(42, logger.span("android.sync.event", traceId, parent) { 42 })
        assertEquals(parent, logger.pending().last().parentSpanId)
        logger.acknowledge(logger.pending().map { it.spanId }.toSet())
        assertTrue(logger.pending().isEmpty())
        assertEquals(100, logger.retainedTraceCount)
    }

    @Test
    fun logFailureCannotReplaceBusinessResult() {
        val logger = TraceLogger { throw IllegalStateException("LOG_FAILED") }
        assertEquals("ok", logger.span("android.sync.event") { "ok" })
    }
}
