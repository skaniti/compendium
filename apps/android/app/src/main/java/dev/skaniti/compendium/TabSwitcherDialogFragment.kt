package dev.skaniti.compendium

import android.graphics.Canvas
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatDialogFragment
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.PagerSnapHelper
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.snackbar.Snackbar
import dev.skaniti.compendium.adapter.TabCardAdapter
import kotlin.math.abs
import kotlin.math.min

/**
 * Full-screen tab switcher in the style of Android's recent apps: cards side by side,
 * swipe left and right to move between them, swipe a card up to close its tab, press
 * and hold to pin or unpin. Close all spares pinned tabs and offers Undo.
 * Tab actions go back to MainActivity through [TabSwitcherListener].
 */
class TabSwitcherDialogFragment : AppCompatDialogFragment() {

    interface TabSwitcherListener {
        fun getTabManager(): TabManager
        fun onTabSelected(tabId: Int)
        fun onTabClosed(tabId: Int)
        fun onTabPinToggled(tabId: Int)
        /** Close every unpinned tab; returns how many were closed. */
        fun onCloseUnpinned(): Int
        /** Reopen what Close all closed; returns how many came back. */
        fun onUndoCloseAll(): Int
        /** The Undo offer is gone; the closed tabs cannot come back. */
        fun onCloseAllUndoExpired()
        fun onNewTabRequested()
    }

    companion object {
        private const val CARD_WIDTH_FRACTION = 0.72f
        private const val UNDO_SHOWN_MS = 5_000
    }

    private var listener: TabSwitcherListener? = null
    private lateinit var adapter: TabCardAdapter
    private lateinit var cards: RecyclerView
    private lateinit var countLabel: TextView
    private val snapHelper = PagerSnapHelper()
    private var undoBar: Snackbar? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setStyle(STYLE_NO_TITLE, R.style.Theme_Collector_Switcher)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_tab_switcher, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        listener = activity as? TabSwitcherListener
        if (listener == null) { dismiss(); return }

        countLabel = view.findViewById(R.id.tabCountLabel)
        cards = view.findViewById(R.id.tabCards)
        adapter = TabCardAdapter(
            onTabSelected = { id ->
                listener?.onTabSelected(id)
                dismiss()
            },
            onPinToggled = { id ->
                listener?.onTabPinToggled(id)
                adapter.pinChanged(id)
                updateCount()
            },
        )
        cards.layoutManager = LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        cards.adapter = adapter
        snapHelper.attachToRecyclerView(cards)
        ItemTouchHelper(SwipeUpToClose()).attachToRecyclerView(cards)
        cards.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) = shrinkSideCards()
        })

        // Size the cards from the list's width: the centred card takes most of it and
        // the padding lets the first and last cards centre too, so neighbours peek in.
        cards.post {
            val cardWidth = (cards.width * CARD_WIDTH_FRACTION).toInt()
            val side = (cards.width - cardWidth) / 2
            cards.setPadding(side, 0, side, 0)
            adapter.cardWidth = cardWidth
            refresh()
            val manager = listener?.getTabManager() ?: return@post
            val active = adapter.positionOf(manager.activeTabId).coerceAtLeast(0)
            (cards.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(active, 0)
            cards.post { shrinkSideCards() }
        }

        view.findViewById<MaterialButton>(R.id.btnCloseAll).setOnClickListener { closeAll(view) }
        view.findViewById<MaterialButton>(R.id.btnSwitcherNewTab).setOnClickListener {
            listener?.onNewTabRequested()
            dismiss()
        }
    }

    private fun updateCount() {
        val tabs = listener?.getTabManager()?.allTabs ?: return
        val pinned = tabs.count { it.pinned }
        val tabWord = if (tabs.size == 1) "tab" else "tabs"
        countLabel.text = if (pinned > 0) "${tabs.size} $tabWord · $pinned pinned" else "${tabs.size} $tabWord"
    }

    /** Settle on the nearest card once the list stops moving (after a removal). */
    private fun snapWhenSettled() {
        cards.itemAnimator?.isRunning {
            val lm = cards.layoutManager ?: return@isRunning
            val target = snapHelper.findSnapView(lm) ?: return@isRunning
            val (dx, dy) = snapHelper.calculateDistanceToFinalSnap(lm, target) ?: return@isRunning
            if (dx != 0 || dy != 0) cards.smoothScrollBy(dx, dy)
        }
    }

    /** Rebind from the tab manager; [centreOn] re-centres on that position after a removal. */
    private fun refresh(centreOn: Int? = null) {
        val manager = listener?.getTabManager() ?: return
        val tabs = manager.allTabs
        adapter.submit(tabs, manager.activeTabId)
        updateCount()
        if (centreOn != null && tabs.isNotEmpty()) {
            // A data-set change does not snap by itself; land squarely on a card.
            (cards.layoutManager as LinearLayoutManager)
                .scrollToPositionWithOffset(centreOn.coerceIn(0, tabs.size - 1), 0)
        }
        cards.post { shrinkSideCards() }
    }


    private fun closeAll(root: View) {
        val closed = listener?.onCloseUnpinned() ?: 0
        if (closed == 0) {
            // A repeat tap must not push a live Undo off the screen.
            if (undoBar?.isShown != true) Snackbar.make(root, "Every tab is pinned", Snackbar.LENGTH_SHORT).show()
            return
        }
        val manager = listener?.getTabManager() ?: return
        refresh(centreOn = manager.allTabs.indexOfFirst { it.id == manager.activeTabId })
        val tabWord = if (closed == 1) "tab" else "tabs"
        undoBar = Snackbar.make(root, "Closed $closed $tabWord", UNDO_SHOWN_MS)
            .setAction("Undo") {
                listener?.onUndoCloseAll()
                val m = listener?.getTabManager() ?: return@setAction
                refresh(centreOn = m.allTabs.indexOfFirst { it.id == m.activeTabId })
            }
            .addCallback(object : Snackbar.Callback() {
                override fun onDismissed(bar: Snackbar, event: Int) {
                    // A newer Close all replaces this snackbar and keeps both batches undoable.
                    if (event != DISMISS_EVENT_ACTION && event != DISMISS_EVENT_CONSECUTIVE) {
                        listener?.onCloseAllUndoExpired()
                    }
                }
            })
        undoBar?.show()
    }

    /** Scale and fade cards by their distance from the centre, like Android's recents. */
    private fun shrinkSideCards() {
        val centre = cards.width / 2f
        for (i in 0 until cards.childCount) {
            val child = cards.getChildAt(i)
            val childCentre = (child.left + child.right) / 2f
            val distance = min(1f, abs(childCentre - centre) / child.width.coerceAtLeast(1))
            val scale = 1f - 0.08f * distance
            child.scaleX = scale
            child.scaleY = scale
            if (child.translationY == 0f) child.alpha = 1f - 0.3f * distance
        }
    }

    /** Swipe a card up to close its tab; the card fades as it rises. */
    private inner class SwipeUpToClose : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.UP) {
        override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder) = false

        override fun getSwipeThreshold(vh: RecyclerView.ViewHolder) = 0.25f

        override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {
            val position = vh.bindingAdapterPosition
            val id = adapter.tabIdAt(position) ?: return
            val manager = listener?.getTabManager() ?: return
            listener?.onTabClosed(id)
            val expected = adapter.tabIds() - id
            if (manager.allTabs.map { it.id } == expected) {
                // The usual case: drop just this card so the neighbours slide into its place.
                adapter.removeAt(position)
                adapter.activeChanged(manager.activeTabId)
                updateCount()
                snapWhenSettled()
            } else {
                // Closing the last tab opened a fresh one: rebuild the list.
                refresh(centreOn = position)
            }
        }

        override fun onChildDraw(
            c: Canvas, rv: RecyclerView, vh: RecyclerView.ViewHolder,
            dX: Float, dY: Float, actionState: Int, isCurrentlyActive: Boolean,
        ) {
            // The card follows the finger (super translates it) and, as it rises, shrinks a
            // little and fades only gently, the way Android's recents cards fly off.
            super.onChildDraw(c, rv, vh, dX, dY, actionState, isCurrentlyActive)
            val progress = min(1f, abs(dY) / vh.itemView.height.coerceAtLeast(1))
            val scale = 1f - 0.1f * progress
            vh.itemView.scaleX = scale
            vh.itemView.scaleY = scale
            vh.itemView.alpha = 1f - 0.5f * progress
        }

        override fun clearView(rv: RecyclerView, vh: RecyclerView.ViewHolder) {
            super.clearView(rv, vh)
            vh.itemView.alpha = 1f
            vh.itemView.scaleX = 1f
            vh.itemView.scaleY = 1f
            shrinkSideCards()
        }
    }
}
