package dev.skaniti.compendium.gecko

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mozilla.geckoview.PanZoomController

/**
 * Regression guard for pull-to-refresh stealing upward scrolls on pages that
 * scroll an inner element (code-viz board: body overflow hidden, #cards
 * overflow-y auto). The refresh is gated on Gecko's verdict for the gesture's
 * scroll container, never on the document's root scrollY.
 */
class PullRefreshGateTest {

    private val handled = PanZoomController.INPUT_RESULT_HANDLED
    private val vertical = PanZoomController.OVERSCROLL_FLAG_VERTICAL
    private val top = PanZoomController.SCROLLABLE_FLAG_TOP
    private val bottom = PanZoomController.SCROLLABLE_FLAG_BOTTOM

    @Test
    fun innerScrollerScrolledDownBlocksRefresh() {
        assertFalse(canOverscrollTop(handled, top or bottom, vertical))
    }

    @Test
    fun scrollerAtTopAllowsRefresh() {
        assertTrue(
            canOverscrollTop(handled, bottom, vertical or PanZoomController.OVERSCROLL_FLAG_HORIZONTAL),
        )
    }

    @Test
    fun touchConsumedByPageListenersBlocksRefresh() {
        assertFalse(
            canOverscrollTop(
                PanZoomController.INPUT_RESULT_HANDLED_CONTENT,
                PanZoomController.SCROLLABLE_FLAG_NONE,
                vertical,
            ),
        )
    }

    @Test
    fun overscrollBehaviorNoneBlocksRefresh() {
        assertFalse(canOverscrollTop(handled, bottom, PanZoomController.OVERSCROLL_FLAG_NONE))
    }

    @Test
    fun unansweredGestureIsPresumedRefreshable() {
        // SwipeRefreshLayout records the ACTION_DOWN position only when the
        // child cannot scroll up at that moment, before Gecko has answered.
        assertTrue(canOverscrollTop(INPUT_RESULT_UNKNOWN, PanZoomController.SCROLLABLE_FLAG_NONE, vertical))
    }

    @Test
    fun releasesToRefreshUnlessTheGestureStartedScrollingDown() {
        assertTrue(shouldReleaseToRefresh(canOverscrollTop = true, firstMove = FirstMove.NONE))
        assertTrue(shouldReleaseToRefresh(canOverscrollTop = true, firstMove = FirstMove.PULL))
        assertFalse(shouldReleaseToRefresh(canOverscrollTop = true, firstMove = FirstMove.PUSH))
        assertFalse(shouldReleaseToRefresh(canOverscrollTop = false, firstMove = FirstMove.PULL))
    }
}
