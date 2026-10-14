package site.codexassistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NetworkAvailabilityTest {
    @Test
    fun usesSystemDefaultWhenAvailable() {
        assertEquals("default", currentOrConnectedNetwork("default", arrayOf("other")))
    }

    @Test
    fun fallsBackToAnEstablishedNetworkBeforeInternetValidation() {
        assertEquals("local", currentOrConnectedNetwork(null, arrayOf("local")))
    }

    @Test
    fun reportsUnavailableWhenNoNetworkIsConnected() {
        assertNull(currentOrConnectedNetwork(null, emptyArray<String>()))
    }
}
