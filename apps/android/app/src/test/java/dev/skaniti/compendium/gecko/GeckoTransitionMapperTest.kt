package dev.skaniti.compendium.gecko

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Contract from spike-verdict.md §(a) + plan Task 6 mapping table.
 * Signal sequences mirror real journal captures from the 2026-06-10 spike.
 */
class GeckoTransitionMapperTest {

    @Test
    fun typedNavigation() {
        val m = GeckoTransitionMapper()
        m.markTyped()
        m.onLoadRequest(hasGesture = false, isRedirect = false)
        m.onVisited()
        m.onLocationChanged()
        assertEquals("typed" to emptyList<String>(), m.consume())
    }

    @Test
    fun linkClick() {
        val m = GeckoTransitionMapper()
        m.onLoadRequest(hasGesture = true, isRedirect = false)
        m.onVisited()
        m.onLocationChanged()
        assertEquals("link" to emptyList<String>(), m.consume())
    }

    @Test
    fun typedWithHttpRedirectKeepsTypeAddsQualifier() {
        // wikipedia.org -> www.wikipedia.org 301 from the spike journal
        val m = GeckoTransitionMapper()
        m.markTyped()
        m.onLoadRequest(hasGesture = false, isRedirect = false)
        m.onVisited()
        m.onLoadRequest(hasGesture = false, isRedirect = true)
        m.onVisited()
        m.onLocationChanged()
        assertEquals("typed" to listOf("server_redirect"), m.consume())
    }

    @Test
    fun uiBackButton() {
        val m = GeckoTransitionMapper()
        m.markBack()
        m.onLocationChanged()
        assertEquals("back_forward" to emptyList<String>(), m.consume())
    }

    @Test
    fun jsHistoryTraversalWithoutMarker() {
        // locationChange with no loadRequest and no visited = history traversal
        val m = GeckoTransitionMapper()
        m.onLocationChanged()
        assertEquals("back_forward" to emptyList<String>(), m.consume())
    }

    @Test
    fun spaNavigationVisitedWithoutLoadRequest() {
        val m = GeckoTransitionMapper()
        m.onVisited()
        m.onLocationChanged()
        assertEquals("spa_navigation" to emptyList<String>(), m.consume())
    }

    @Test
    fun tabSwitchMarker() {
        val m = GeckoTransitionMapper()
        m.markTabSwitch()
        assertEquals("tab_switch" to emptyList<String>(), m.consume())
    }

    @Test
    fun consumeResetsState() {
        val m = GeckoTransitionMapper()
        m.markTyped()
        m.consume()
        m.onLoadRequest(hasGesture = true, isRedirect = false)
        m.onVisited()
        assertEquals("link" to emptyList<String>(), m.consume())
    }

    @Test
    fun noSignalsDefaultsToLink() {
        assertEquals("link" to emptyList<String>(), GeckoTransitionMapper().consume())
    }
}
