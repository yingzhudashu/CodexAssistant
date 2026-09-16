package site.codexassistant

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
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
        assertNull(tracker.changes.getValue("new").previous)
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
        assertEquals("completed", latest.previous!!.status)
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
        assertEquals("running", change.previous!!.status)
        assertEquals("needs_action", change.task.status)
        tracker.acknowledge("task", change.revision)
        tracker.snapshot(listOf(task(status = "needs_action")), "again", 300)
        assertTrue(tracker.changes.isEmpty())
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
                postTask = { posted += testScheduler.currentTime to it.task.status },
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
            NotificationDelivery(backgroundScope, { ids += it.task.id }, {}, { resets++ })
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
}
