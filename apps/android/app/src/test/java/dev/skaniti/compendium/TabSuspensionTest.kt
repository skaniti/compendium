package dev.skaniti.compendium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Only the most recently used tabs keep a live GeckoSession; the rest are
 * suspended and restored from saved state when opened (dev-note 1790469258128).
 */
class TabSuspensionTest {

    @Test
    fun nothingSuspendedAtOrUnderTheBudget() {
        val live = listOf(LiveTab(1, 10), LiveTab(2, 20), LiveTab(3, 30))
        assertEquals(emptyList<Int>(), idleTabsToSuspend(live, activeId = 3, maxLive = 3))
    }

    @Test
    fun suspendsTheLeastRecentlyUsedBeyondTheBudget() {
        val live = listOf(LiveTab(1, 10), LiveTab(2, 40), LiveTab(3, 20), LiveTab(4, 50), LiveTab(5, 30))
        assertEquals(listOf(1, 3), idleTabsToSuspend(live, activeId = 4, maxLive = 3))
    }

    @Test
    fun neverSuspendsTheActiveTabEvenIfItIsTheOldest() {
        // A freshly opened tab can be active before its first recorded use.
        val live = listOf(LiveTab(1, 0), LiveTab(2, 40), LiveTab(3, 20), LiveTab(4, 50))
        assertEquals(listOf(3), idleTabsToSuspend(live, activeId = 1, maxLive = 3))
    }
}
