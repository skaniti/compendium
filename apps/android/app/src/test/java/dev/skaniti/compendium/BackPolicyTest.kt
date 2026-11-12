package dev.skaniti.compendium

import dev.skaniti.compendium.BackPolicy.Action
import org.junit.Assert.assertEquals
import org.junit.Test

class BackPolicyTest {
    @Test
    fun fullScreenExitsFirst() {
        assertEquals(Action.EXIT_FULLSCREEN, BackPolicy.decide(hasTab = true, isFullScreen = true, canGoBack = true))
    }

    @Test
    fun historyGoesBack() {
        assertEquals(Action.GO_BACK, BackPolicy.decide(hasTab = true, isFullScreen = false, canGoBack = true))
    }

    @Test
    fun noHistoryBackgroundsInsteadOfFinishing() {
        assertEquals(Action.MOVE_TO_BACKGROUND, BackPolicy.decide(hasTab = true, isFullScreen = false, canGoBack = false))
    }

    @Test
    fun noTabBackgrounds() {
        assertEquals(Action.MOVE_TO_BACKGROUND, BackPolicy.decide(hasTab = false, isFullScreen = true, canGoBack = true))
    }
}
