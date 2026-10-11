package dev.skaniti.compendium.gecko

import android.annotation.SuppressLint
import android.content.Context
import android.view.MotionEvent
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.PanZoomController

/** Gecko has not answered yet for the current gesture (outside PanZoomController's INPUT_RESULT_* range). */
internal const val INPUT_RESULT_UNKNOWN = -1

/** The first vertical movement of a gesture: PULL = finger moving down, PUSH = finger moving up. */
internal enum class FirstMove { NONE, PULL, PUSH }

/**
 * Whether the gesture may overscroll the page at its top, from Gecko's verdict on its
 * ACTION_DOWN: not consumed by page touch listeners, the scroll container it landed in
 * cannot scroll further up, and that container allows vertical overscroll (CSS
 * overscroll-behavior). Same rule as android-components' InputResultDetail.canOverscrollTop.
 */
internal fun canOverscrollTop(handledResult: Int, scrollableDirections: Int, overscrollDirections: Int): Boolean =
    handledResult != PanZoomController.INPUT_RESULT_HANDLED_CONTENT &&
        scrollableDirections and PanZoomController.SCROLLABLE_FLAG_TOP == 0 &&
        overscrollDirections and PanZoomController.OVERSCROLL_FLAG_VERTICAL != 0

/** A gesture that already started scrolling the page down stays with Gecko, whatever the late verdict says. */
internal fun shouldReleaseToRefresh(canOverscrollTop: Boolean, firstMove: FirstMove): Boolean =
    canOverscrollTop && firstMove != FirstMove.PUSH

/**
 * GeckoView that tells its SwipeRefreshLayout parent whether the current gesture may pull
 * to refresh, from Gecko's own input result (the approach of Fenix's NestedGeckoView). The
 * document's scrollY cannot answer that: a page that scrolls an inner element keeps it at
 * 0, so gating on it handed every downward swipe to the refresh.
 *
 * Each gesture starts with the parent barred from intercepting; Gecko's answer to the
 * ACTION_DOWN lifts the bar only when the page is at its top and did not consume the touch.
 */
class PullRefreshGeckoView(context: Context) : GeckoView(context) {

    private var gesture = 0
    private var downY = 0f
    private var firstMove = FirstMove.NONE
    private var overscrollTop = presumedRefreshable()

    init {
        // SwipeRefreshLayout ignores requestDisallowInterceptTouchEvent from a child without
        // nested scrolling enabled. Nothing here dispatches nested scroll events, so this
        // flag changes nothing else.
        isNestedScrollingEnabled = true
    }

    /** Whether the current gesture may pull to refresh; SwipeRefreshLayout's canChildScrollUp is its negation. */
    fun canPullToRefresh(): Boolean = overscrollTop

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                val thisGesture = ++gesture
                downY = event.y
                firstMove = FirstMove.NONE
                // The ACTION_DOWN goes to Gecko through this call only, never also through
                // super.onTouchEvent. The answer is async: page touch listeners can delay it
                // past the first moves.
                onTouchEventForDetailResult(event).accept { detail ->
                    if (detail == null || thisGesture != gesture) return@accept
                    overscrollTop = canOverscrollTop(
                        detail.handledResult(),
                        detail.scrollableDirections(),
                        detail.overscrollDirections(),
                    )
                    if (shouldReleaseToRefresh(overscrollTop, firstMove)) {
                        parent?.requestDisallowInterceptTouchEvent(false)
                    }
                }
                return true
            }
            MotionEvent.ACTION_MOVE -> if (firstMove == FirstMove.NONE && event.y != downY) {
                firstMove = if (event.y > downY) FirstMove.PULL else FirstMove.PUSH
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                // Reset now, not on the next ACTION_DOWN: the parent asks canChildScrollUp
                // for that DOWN before this view sees it. A late answer for this gesture is
                // dropped by the gesture counter.
                gesture++
                overscrollTop = presumedRefreshable()
                parent?.requestDisallowInterceptTouchEvent(false)
            }
        }
        return super.onTouchEvent(event)
    }

    private fun presumedRefreshable() = canOverscrollTop(
        INPUT_RESULT_UNKNOWN,
        PanZoomController.SCROLLABLE_FLAG_NONE,
        PanZoomController.OVERSCROLL_FLAG_VERTICAL,
    )
}
