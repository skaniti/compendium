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

    @Test
    fun zeroTabSnapshotIsNeverPersisted() {
        val empty = TabsStore.TabsSnapshot(activeTabId = -1, tabs = emptyList())
        val one = TabsStore.TabsSnapshot(
            activeTabId = 1,
            tabs = listOf(TabsStore.TabSnapshot(1, "Wiki", "https://en.wikipedia.org/")),
        )
        assertEquals(false, TabsStore.shouldPersist(empty))
        assertEquals(true, TabsStore.shouldPersist(one))
    }

    @Test
    fun truncatedFileDecodesToFailureInsteadOfThrowing() {
        val truncated = """{"activeTabId":1,"tabs":[{"id":1,"title":"t","url":"https://e"""
        assertEquals(true, TabsStore.decodeResult(truncated).isFailure)
        assertEquals(true, TabsStore.decodeResult("").isFailure)
    }
}
