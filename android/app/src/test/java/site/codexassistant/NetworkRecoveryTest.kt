package site.codexassistant

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NetworkRecoveryTest {
    private val authenticated =
        """{"type":"authenticated","protocolVersion":"codex-assistant.v3"}"""

    private fun snapshot(cursor: Int = 42) =
        """{"type":"snapshot","protocolVersion":"codex-assistant.v3","cursor":$cursor,"tasks":[]}"""

    private class Socket(val req: Request) : WebSocket {
        val sent = mutableListOf<String>()
        var cancelled = false

        override fun request() = req

        override fun queueSize() = 0L

        override fun send(text: String): Boolean {
            sent += text
            return !cancelled
        }

        override fun send(bytes: ByteString) = !cancelled

        override fun close(code: Int, reason: String?) = true

        override fun cancel() {
            cancelled = true
        }
    }

    private class Sockets : WebSocket.Factory {
        val connections = mutableListOf<Pair<Socket, WebSocketListener>>()

        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
            Socket(request).also { connections += it to listener }

        fun open(index: Int = connections.lastIndex) {
            val (s, l) = connections[index]
            l.onOpen(
                s,
                Response.Builder()
                    .request(s.req)
                    .protocol(Protocol.HTTP_1_1)
                    .code(101)
                    .message("upgrade")
                    .build(),
            )
        }

        fun message(text: String, index: Int = connections.lastIndex) {
            val (s, l) = connections[index]
            l.onMessage(s, text)
        }
    }

    @Test
    fun totalAndPostOpenDeadlinesRetryAndOnlySnapshotResetsBackoff() = runTest {
        val sockets = Sockets()
        val states = mutableListOf<TaskState>()
        val repo =
            TaskRepository(
                { "synthetic-test-token" },
                { "http://127.0.0.1:1" },
                {},
                TaskState(networkAvailable = true),
                elapsed = { testScheduler.currentTime },
                traceLogger = TraceLogger {},
                sockets = sockets,
            )
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            repo.stream().collect { states += it }
        }
        runCurrent()
        assertEquals(1, sockets.connections.size)
        advanceTimeBy(25_000)
        runCurrent()
        assertTrue(sockets.connections[0].first.cancelled)
        assertEquals(1, states.last().retryAttempt)
        advanceTimeBy(1000)
        runCurrent()
        sockets.open()
        runCurrent()
        assertEquals(1, states.last().retryAttempt)
        advanceTimeBy(15_000)
        runCurrent()
        assertEquals(2, states.last().retryAttempt)
        advanceTimeBy(2000)
        runCurrent()
        sockets.open()
        sockets.message(authenticated)
        sockets.message(snapshot())
        runCurrent()
        assertTrue(states.last().connected)
        assertEquals(0, states.last().retryAttempt)
        repo.stop()
    }

    @Test
    fun staleCallbacksCannotChangeStateOrCursorAndWritesWaitForSnapshot() = runTest {
        val sockets = Sockets()
        val states = mutableListOf<TaskState>()
        val cursors = mutableListOf<Long>()
        val repo =
            TaskRepository(
                { "synthetic-test-token" },
                { "http://127.0.0.1:1" },
                { cursors += it },
                TaskState(networkAvailable = true),
                elapsed = { testScheduler.currentTime },
                traceLogger = TraceLogger {},
                sockets = sockets,
            )
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            repo.stream().collect { states += it }
        }
        runCurrent()
        sockets.open()
        sockets.message(authenticated)
        assertThrows(IllegalStateException::class.java) { repo.sendMessage("task", "hello") }
        repo.recover(true, networkChanged = true)
        runCurrent()
        sockets.open()
        sockets.message(authenticated)
        sockets.message(snapshot(7))
        runCurrent()
        sockets.message(snapshot(999), 0)
        sockets.connections[0].let { (s, l) ->
            l.onFailure(s, IOException("late"), null)
            l.onClosed(s, 1000, "")
        }
        runCurrent()
        assertTrue(states.last().connected)
        assertEquals(listOf(7L), cursors)
        repo.sendMessage("task", "one")
        repo.recover(true, foreground = true)
        runCurrent()
        repeat(10) { repo.recover(true, foreground = true) }
        runCurrent()
        assertEquals(3, sockets.connections.size)
        assertTrue(
            sockets.connections.last().first.sent.isEmpty()
        ) // No application-message replay.
        repo.stop()
        sockets.open()
        runCurrent()
        assertTrue(sockets.connections.last().first.cancelled)
    }

    @Test
    fun offlineAndPermanentErrorsDoNotLoopOnForegroundOrNetworkSignals() = runTest {
        val sockets = Sockets()
        val states = mutableListOf<TaskState>()
        val repo =
            TaskRepository(
                { "synthetic-test-token" },
                { "http://127.0.0.1:1" },
                {},
                TaskState(networkAvailable = false),
                elapsed = { testScheduler.currentTime },
                traceLogger = TraceLogger {},
                sockets = sockets,
            )
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            repo.stream().collect { states += it }
        }
        runCurrent()
        advanceTimeBy(60_000)
        runCurrent()
        assertTrue(sockets.connections.isEmpty())
        repo.recover(true)
        runCurrent()
        sockets.open()
        sockets.message(
            """{"type":"error","protocolVersion":"codex-assistant.v3","code":"auth_required","message":"denied"}"""
        )
        runCurrent()
        repeat(5) {
            repo.recover(false)
            repo.recover(true, true)
        }
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, sockets.connections.size)
        assertEquals("auth_failed", states.last().connectionStatus)
        repo.stop()
    }

    @Test
    fun burstReceiptsSurviveAConflatedSlowCollector() = runTest {
        val sockets = Sockets()
        val states = mutableListOf<TaskState>()
        val repo =
            TaskRepository(
                { "synthetic-test-token" },
                { "http://127.0.0.1:1" },
                {},
                TaskState(networkAvailable = true),
                elapsed = { testScheduler.currentTime },
                traceLogger = TraceLogger {},
                sockets = sockets,
            )
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            repo.stream().collect {
                states += it
                delay(100)
            }
        }
        runCurrent()
        sockets.open()
        sockets.message(authenticated)
        sockets.message(snapshot())
        repeat(150) { i ->
            sockets.message(
                """{"type":"result","protocolVersion":"codex-assistant.v3","requestId":"r-$i","threadId":"t-$i","status":"started"}"""
            )
        }
        advanceTimeBy(200)
        runCurrent()
        assertTrue(states.last().connected)
        assertEquals(150, states.last().results.size)
        assertEquals("started", states.last().results["r-149"]?.status)
        repo.stop()
    }

    @Test
    fun realWebSocketReauthenticatesTwentyTimesAndResumesCursor(): Unit = runBlocking {
        val server = MockWebServer()
        val subscriptions = CopyOnWriteArrayList<Long>()
        val accepted = AtomicInteger()
        server.dispatcher =
            object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.path!!.contains("/traces/")) return MockResponse().setBody("{}")
                    return MockResponse()
                        .withWebSocketUpgrade(
                            object : WebSocketListener() {
                                override fun onMessage(ws: WebSocket, text: String) {
                                    if (text.contains("\"type\":\"auth\"")) ws.send(authenticated)
                                    else if (text.contains("\"type\":\"subscribe\"")) {
                                        subscriptions +=
                                            Regex("\"after\":(\\d+)")
                                                .find(text)!!
                                                .groupValues[1]
                                                .toLong()
                                        ws.send(snapshot(accepted.incrementAndGet()))
                                    }
                                }
                            }
                        )
                }
            }
        server.start()
        val repo =
            TaskRepository(
                { "synthetic-test-token" },
                { server.url("/").toString().trimEnd('/') },
                {},
                TaskState(networkAvailable = true),
                elapsed = { System.nanoTime() / 1_000_000 },
                traceLogger = TraceLogger {},
            )
        val state = MutableStateFlow(TaskState())
        val job = launch(Dispatchers.Default) { repo.stream().collect { state.value = it } }
        try {
            withTimeout(5000) { state.first { it.connected } }
            repeat(20) { index ->
                repo.recover(true, foreground = true)
                withTimeout(5000) {
                    state.first { it.connected && it.cursor == (index + 2).toLong() }
                }
            }
            assertEquals((0L..20L).toList(), subscriptions.toList())
            repo.recover(false)
            withTimeout(1000) { state.first { !it.connected && it.networkAvailable == false } }
            delay(1200)
            assertEquals(21, accepted.get())
            repo.recover(true)
            withTimeout(5000) { state.first { it.connected && it.cursor == 22L } }
        } finally {
            repo.stop()
            job.cancelAndJoin()
            server.shutdown()
        }
    }
}
