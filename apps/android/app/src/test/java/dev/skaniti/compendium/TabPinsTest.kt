package dev.skaniti.compendium

import org.junit.Assert.assertEquals
import org.junit.Test

/** Close all spares pinned tabs, and Undo puts the closed ones back where they were. */
class TabPinsTest {

    @Test
    fun closeAllTargetsExactlyTheUnpinnedTabs() {
        val pins = listOf(1 to false, 2 to true, 3 to false, 4 to true)
        assertEquals(listOf(1, 3), unpinnedTabIds(pins))
    }

    @Test
    fun closeAllWithEverythingPinnedClosesNothing() {
        assertEquals(emptyList<Int>(), unpinnedTabIds(listOf(1 to true, 2 to true)))
    }

    @Test
    fun undoReinsertsClosedTabsAtTheirOldPositions() {
        // Before Close all: a b c d e with b and d pinned; a, c and e were closed.
        val remaining = listOf("b", "d")
        val closed = listOf(0 to "a", 2 to "c", 4 to "e")
        assertEquals(listOf("a", "b", "c", "d", "e"), reinsertAt(remaining, closed))
    }

    @Test
    fun undoAppendsWhenTheOldPositionIsPastTheEnd() {
        // A pinned tab was closed by swipe in the meantime, so the list is shorter.
        assertEquals(listOf("b", "a", "c"), reinsertAt(listOf("b"), listOf(3 to "a", 4 to "c")))
    }
}
