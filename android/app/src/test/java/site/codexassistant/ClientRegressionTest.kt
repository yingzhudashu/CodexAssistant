package site.codexassistant

import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Executors

class ClientRegressionTest {
    @Test fun secondaryPagesReturnToSettingsAndHideRootNavigation() {
        for (page in listOf("connection", "appearance", "notifications", "about")) {
            assertFalse(showPrimaryNavigation(page, null, false))
            assertEquals("settings", parentPage(page))
            assertEquals("tasks", parentPage(parentPage(page)))
        }
        assertTrue(showPrimaryNavigation("tasks", null, false))
        assertTrue(showPrimaryNavigation("settings", null, false))
        assertFalse(showPrimaryNavigation("tasks", "task-1", false))
        assertFalse(showPrimaryNavigation("tasks", null, true))
    }

    @Test fun everyProtocolTaskStateCanBeFilteredUsingItsNotificationLabel() {
        val statuses = listOf("active", "waiting", "paused", "blocked", "usage_limited", "budget_limited", "idle", "complete", "failed")
        assertEquals(listOf("all") + statuses, taskStatusFilters.map { it.first })
        for ((id, label) in taskStatusFilters.drop(1)) assertEquals(statusLabel(id), label)
    }
    @Test fun taskTimesConvertTheInstantToDeviceTimezoneIncludingDateAndOffset() {
        val china = java.time.ZoneId.of("Asia/Shanghai")
        assertEquals("2026-09-09 00:30:00 +08:00", formatTime("2026-09-08T16:30:00.000Z", china))
        assertEquals("2026-09-08 16:30:00 +00:00", formatTime("2026-09-08T16:30:00Z", java.time.ZoneId.of("UTC")))
        assertEquals("2026-09-09 00:30:00 +08:00", formatTime("2026-09-09T00:30:00+08:00", china))
        val newYork = java.time.ZoneId.of("America/New_York")
        assertEquals("2026-07-01 08:00:00 -04:00", formatTime("2026-07-01T12:00:00Z", newYork))
        assertEquals("2026-01-01 07:00:00 -05:00", formatTime("2026-01-01T12:00:00Z", newYork))
        assertEquals("时间不可用", formatTime("2026-09-08 16:30:00", china))
    }

    private val manifest = """{"product":"CodexAssistant","protocolVersion":"codex-assistant.v2","downloads":{"android":{"versionName":"2.0.3","versionCode":6,"url":"https://server.example.com/app.apk"},"windows":{"url":"https://server.example.com/app.exe"}}}"""

    @Test fun updateRequestLeavesTheCallingUiThread() {
        var networkThread = ""
        val client = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            networkThread = Thread.currentThread().name
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(manifest.toResponseBody()).build()
        }).build()
        Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "test-ui") }.asCoroutineDispatcher().use { ui ->
            runBlocking(ui) {
                assertTrue(Thread.currentThread().name.startsWith("test-ui"))
                val info = UpdateChecker(client).check("https://server.example.com")
                assertEquals(6, info.versionCode)
                assertNotEquals("test-ui", networkThread)
                assertTrue(Thread.currentThread().name.startsWith("test-ui"))
            }
        }
    }

    @Test fun updateRejectsWrongProtocolAndUnsafeDownloads() {
        for (invalid in listOf(manifest.replace("codex-assistant.v2", "codex-assistant.v1"), manifest.replace("https://server.example.com/app.apk", "http://server.example.com/app.apk"))) {
            assertThrows(IllegalArgumentException::class.java) { UpdateChecker.parse(invalid) }
        }
    }

    @Test fun actualWireSerializerSendsRequiredDefaultsAndOmitsOptionalNulls() {
        val auth = wireJson.parseToJsonElement(wireJson.encodeToString(ClientAuthMessage(token = "test-token-123456"))).jsonObject
        assertEquals(setOf("type", "protocolVersion", "token"), auth.keys)
        val subscription = wireJson.parseToJsonElement(wireJson.encodeToString(ClientSubscribeMessage(after = 42))).jsonObject
        assertEquals(setOf("type", "protocolVersion", "after"), subscription.keys)
        val span = TraceSpan("a".repeat(32), "b".repeat(16), name = "test", startedAt = "2026-09-08T00:00:00Z", endedAt = "2026-09-08T00:00:00Z")
        val payload = wireJson.encodeToString(TraceSpanBatch(spans = listOf(span)))
        assertFalse(payload.contains(":null"))
        assertTrue(payload.contains(PROTOCOL_VERSION))
    }

    @Test fun notificationThrottlePreservesTheFinalStateAndAllStatusLabels() {
        val task = TaskSnapshot("task", "任务名称", status = "active", runtimeStatus = "notLoaded", freshness = "fresh", source = "thread", updatedAt = "2026-09-08T00:00:00Z", changedAt = "2026-09-08T00:00:00Z")
        val notices = TaskNotices()
        val waiting = task.copy(status = "waiting")
        assertFalse(notices.change(task, waiting, 100).silent)
        val completed = notices.change(waiting, task.copy(status = "complete"), 200)
        assertTrue(completed.silent)
        assertTrue(completed.title.startsWith("已完成"))
        assertEquals("等待处理 → 已完成", completed.text)
        assertFalse(notices.change(task, task.copy(status = "failed"), 10_100).silent)
        for (status in listOf("active", "waiting", "paused", "blocked", "usage_limited", "budget_limited", "idle", "complete", "failed")) assertNotEquals("未知状态", statusLabel(status))
    }
}
