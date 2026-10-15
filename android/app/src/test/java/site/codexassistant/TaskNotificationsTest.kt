package site.codexassistant

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TaskNotificationsTest {
    private fun task(id: String = "task", status: String = "running") =
        TaskSnapshot(
            id,
            "验收任务",
            status = status,
            runtimeStatus = "active",
            freshness = "fresh",
            source = "thread",
            updatedAt = "2026-09-16T00:00:00Z",
            changedAt = "2026-09-16T00:00:00Z",
        )

    @Test
    fun firstSnapshotDoesNotAlertButLiveNewTasksDo() {
        val tracker = TaskChangeTracker(TaskState())
        tracker.snapshot(listOf(task()), "initial", 0)
        assertTrue(tracker.changes.isEmpty())
        tracker.event(task("new"), "live", 1)
        assertNull(tracker.changes.getValue("new").previousStatus)
        assertEquals("live", tracker.changes.getValue("new").traceId)
    }

    @Test
    fun sameFinalUiStateStillCarriesAnUnacknowledgedTransition() {
        val tracker = TaskChangeTracker(TaskState(tasks = listOf(task())))
        tracker.event(task(status = "completed"), "a", 1)
        val first = tracker.changes.getValue("task")
        tracker.event(task(), "b", 2)
        tracker.acknowledge("task", first.revision)
        val latest = tracker.changes.getValue("task")
        assertEquals("completed", latest.previousStatus)
        assertEquals("running", latest.task.status)
        assertEquals("b", latest.traceId)
        tracker.acknowledge("task", latest.revision)
        assertTrue(tracker.changes.isEmpty())
    }

    @Test
    fun reconnectComparesLastKnownBaselineAndOnlyQueuesFinalSnapshot() {
        val tracker = TaskChangeTracker(TaskState(tasks = listOf(task())))
        tracker.snapshot(listOf(task(status = "needs_action")), "reconnect", 200)
        val change = tracker.changes.getValue("task")
        assertEquals("running", change.previousStatus)
        assertEquals("needs_action", change.task.status)
        tracker.acknowledge("task", change.revision)
        tracker.snapshot(listOf(task(status = "needs_action")), "again", 300)
        assertTrue(tracker.changes.isEmpty())
    }

    @Test
    fun persistedRedactedBaselineRecoversChangesAfterProcessRestart() {
        var stored: NotificationBaseline? = null
        val firstProcess = TaskChangeTracker(TaskState(), persist = { stored = it })
        firstProcess.snapshot(listOf(task()), "initial", 0)
        assertTrue(firstProcess.changes.isEmpty())
        val encoded = wireJson.encodeToString(stored!!)
        assertFalse(encoded.contains("验收任务"))

        val restored = wireJson.decodeFromString<NotificationBaseline>(encoded)
        val secondProcess = TaskChangeTracker(TaskState(), restored, persist = { stored = it })
        secondProcess.snapshot(listOf(task(status = "completed")), "after-restart", 100)
        val change = secondProcess.changes.getValue("task")
        assertEquals("running", change.previousStatus)
        assertEquals("completed", change.task.status)

        secondProcess.acknowledge("task", change.revision)
        val thirdProcess = TaskChangeTracker(TaskState(), stored)
        thirdProcess.snapshot(listOf(task(status = "completed")), "same-state", 200)
        assertTrue(thirdProcess.changes.isEmpty())
    }

    @Test
    fun initializedEmptyBaselineStillNotifiesNewTaskAfterProcessRestart() {
        var stored: NotificationBaseline? = null
        TaskChangeTracker(TaskState(), persist = { stored = it }).snapshot(emptyList(), "empty", 0)
        assertTrue(stored!!.initialized)

        val restored = TaskChangeTracker(TaskState(), stored)
        restored.snapshot(listOf(task()), "new-task", 100)
        assertNull(restored.changes.getValue("task").previousStatus)
    }

    @Test
    fun pendingStateIsBoundedAndRemovedTasksDoNotLeaveOldNotices() {
        val tracker = TaskChangeTracker(TaskState())
        tracker.snapshot(emptyList(), "initial", 0)
        repeat(1100) { tracker.event(task("task-$it"), "trace", it.toLong()) }
        assertEquals(1000, tracker.changes.size)
        tracker.snapshot(listOf(task("task-1099")), "snapshot", 1101)
        assertEquals(setOf("task-1099"), tracker.changes.keys)
    }

    @Test
    fun continuousTrafficCannotStarveNotificationsAndFinalContentIsLatest() = runTest {
        val posted = mutableListOf<Pair<Long, String>>()
        val summaries = mutableListOf<NotificationSnapshot>()
        val delivery =
            NotificationDelivery(
                backgroundScope,
                postTask = {
                    posted += testScheduler.currentTime to it.task.status
                    true
                },
                postSummary = { summaries += it },
            )
        val tracker = TaskChangeTracker(TaskState(tasks = listOf(task())))
        repeat(30) { index ->
            val next = task(status = if (index % 2 == 0) "needs_action" else "completed")
            tracker.event(next, "trace-$index", testScheduler.currentTime)
            delivery.update(
                TaskState(
                    connected = true,
                    connectionStatus = "connected",
                    tasks = listOf(next),
                    taskChanges = tracker.changes,
                )
            )
            runCurrent()
            advanceTimeBy(50)
        }
        advanceTimeBy(1000)
        runCurrent()
        assertEquals(0L, posted.first().first)
        assertTrue(posted.count { it.first <= 1000 } >= 2)
        assertEquals("completed", posted.last().second)
        assertEquals(0, summaries.last().running)
        assertEquals(0, summaries.last().needsAction)
        assertTrue(posted.last().first <= 2000)
    }

    @Test
    fun taskAndSummaryPostsShareOneRateBudgetAndStateRepeatsDoNotRepost() = runTest {
        val times = mutableListOf<Long>()
        val ids = mutableListOf<String>()
        val delivery =
            NotificationDelivery(
                backgroundScope,
                postTask = {
                    times += testScheduler.currentTime
                    ids += it.task.id
                    true
                },
                postSummary = { times += testScheduler.currentTime },
            )
        val tasks = (1..6).map { task("t-$it") }
        val state =
            TaskState(
                tasks = tasks,
                taskChanges = tasks.associate { it.id to TaskChange(1, null, it, "trace", 0) },
            )
        repeat(20) { delivery.update(state) }
        advanceTimeBy(3000)
        runCurrent()
        assertEquals(tasks.map { it.id }, ids)
        assertEquals(7, times.size)
        assertTrue(times.zipWithNext().all { (a, b) -> b - a >= 300 })
        delivery.update(state)
        advanceTimeBy(1000)
        assertEquals(7, times.size)
    }

    @Test
    fun configurationSwitchCancelsQueuedOldAccountNotices() = runTest {
        val ids = mutableListOf<String>()
        var resets = 0
        val delivery =
            NotificationDelivery(
                backgroundScope,
                {
                    ids += it.task.id
                    true
                },
                {},
                { resets++ },
            )
        val tasks = listOf(task("old-1"), task("old-2"))
        delivery.update(
            TaskState(
                tasks = tasks,
                taskChanges = tasks.associate { it.id to TaskChange(1, null, it, "old", 0) },
            )
        )
        runCurrent()
        delivery.update(TaskState(connectionEpoch = 1))
        advanceTimeBy(2000)
        runCurrent()
        assertEquals(listOf("old-1"), ids)
        assertEquals(1, resets)
    }

    @Test
    fun blockedTaskNotificationRemainsQueuedUntilPostingIsAllowed() = runTest {
        var allowed = false
        var attempts = 0
        val delivery =
            NotificationDelivery(
                backgroundScope,
                postTask = {
                    attempts++
                    allowed
                },
                postSummary = {},
            )
        val task = task()
        val change = TaskChange(1, "running", task.copy(status = "completed"), "trace", 0)
        val state = TaskState(taskChanges = mapOf(task.id to change))

        delivery.update(state)
        runCurrent()
        assertEquals(1, attempts)

        allowed = true
        delivery.update(state)
        runCurrent()
        assertEquals(2, attempts)
    }
}
