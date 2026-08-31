package dev.skaniti.compendium

import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionManagerTest {

    private fun threePageSession(): SessionManager {
        val sm = SessionManager()
        sm.startSession()
        sm.recordPage("https://en.wikipedia.org/wiki/A", "A", "typed", emptyList(), tabId = 1)
        sm.recordPage("https://en.wikipedia.org/wiki/B", "B", "link", emptyList(), tabId = 1)
        sm.recordPage("https://en.wikipedia.org/wiki/C", "C", "link", emptyList(), tabId = 1)
        return sm
    }

    @Test
    fun captureIdIsEpochMsWithMobileSuffix() {
        // Extension parity: {epoch-ms}_{9 lowercase alnum}_mobile.
        // Server detection is rsplit("_", 2)[-1] == "mobile" — prefix-agnostic.
        val data = threePageSession().finalizeSession()!!
        assertTrue(
            "id was: ${data.sessionId}",
            Regex("^\\d{13}_[a-z0-9]{9}_mobile$").matches(data.sessionId)
        )
    }

    @Test
    fun emptySessionFinalizesToNull() {
        val sm = SessionManager()
        sm.startSession()
        assertNull(sm.finalizeSession())
    }
}
