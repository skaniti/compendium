package dev.skaniti.compendium.gecko

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TabsStoreTest {

    @Test
    fun snapshotRoundTrips() {
        val snap = TabsStore.TabsSnapshot(
            activeTabId = 2,
            tabs = listOf(
                TabsStore.TabSnapshot(1, "Wiki", "https://en.wikipedia.org/", state = "{...}"),
                TabsStore.TabSnapshot(2, "DDG", "https://duckduckgo.com/", state = null),
            ),
        )
        assertEquals(snap, TabsStore.decode(TabsStore.encode(snap)))
    }

    @Test
    fun stateFieldOmittableForForwardCompat() {
        val decoded = TabsStore.decode(
            """{"activeTabId":1,"tabs":[{"id":1,"title":"t","url":"u","unknownFutureField":true}]}"""
        )
        assertEquals(1, decoded.tabs.size)
        assertNull(decoded.tabs[0].state)
    }
}
