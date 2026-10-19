package site.codexassistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class CodexViewModelTest {
    private fun result(id: String) =
        ResultMessage("result", PROTOCOL_VERSION, id, "thread", "started")

    @Test
    fun latestReceiptWinsWhenHistoryContainsSeveralRequests() {
        val state = projectSendReceipts(TaskState(), listOf(result("old"), result("new")))

        assertEquals("new", state.results["thread"]?.requestId)
    }

    @Test
    fun matchingReceiptClearsInFlightRequest() {
        val state =
            projectSendReceipts(
                TaskState(sending = mapOf("thread" to "new")),
                listOf(result("old"), result("new")),
            )

        assertEquals("new", state.results["thread"]?.requestId)
        assertFalse(state.sending.containsKey("thread"))
    }
}
