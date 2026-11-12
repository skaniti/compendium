package dev.skaniti.compendium.adapter

import android.graphics.Matrix
import android.net.Uri
import android.util.TypedValue
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.card.MaterialCardView
import dev.skaniti.compendium.R
import dev.skaniti.compendium.TabManager
import dev.skaniti.compendium.gecko.TabThumbnails

/** One full-height card per tab: a page preview when there is one, else a title card. */
class TabCardAdapter(
    private val onTabSelected: (Int) -> Unit,
    private val onPinToggled: (Int) -> Unit,
) : RecyclerView.Adapter<TabCardAdapter.CardHolder>() {

    private companion object {
        const val PAYLOAD_PIN = "pin"
        const val PAYLOAD_ACTIVE = "active"
    }

    private var tabs: List<TabManager.Tab> = emptyList()
    private var activeTabId = -1

    /** Card width in px; the switcher sets it from its own width so neighbours peek in. */
    var cardWidth = ViewGroup.LayoutParams.MATCH_PARENT

    fun submit(newTabs: List<TabManager.Tab>, newActiveId: Int) {
        tabs = newTabs
        activeTabId = newActiveId
        notifyDataSetChanged()
    }

    /** Drop one card so its neighbours slide into the gap. */
    fun removeAt(position: Int) {
        tabs = tabs.toMutableList().apply { removeAt(position) }
        notifyItemRemoved(position)
    }

    /** Refresh only the pin badge of [tabId]'s card, leaving its preview untouched. */
    fun pinChanged(tabId: Int) {
        val position = positionOf(tabId)
        if (position >= 0) notifyItemChanged(position, PAYLOAD_PIN)
    }

    /** Move the current-tab outline without rebinding previews. */
    fun activeChanged(newActiveId: Int) {
        val old = positionOf(activeTabId)
        activeTabId = newActiveId
        if (old >= 0) notifyItemChanged(old, PAYLOAD_ACTIVE)
        positionOf(newActiveId).takeIf { it >= 0 }?.let { notifyItemChanged(it, PAYLOAD_ACTIVE) }
    }

    fun tabIds(): List<Int> = tabs.map { it.id }

    fun tabIdAt(position: Int): Int? = tabs.getOrNull(position)?.id
    fun positionOf(tabId: Int): Int = tabs.indexOfFirst { it.id == tabId }

    override fun getItemCount() = tabs.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        CardHolder(LayoutInflater.from(parent.context).inflate(R.layout.item_tab_card, parent, false))

    override fun onBindViewHolder(holder: CardHolder, position: Int) =
        holder.bind(tabs[position], tabs[position].id == activeTabId)

    override fun onBindViewHolder(holder: CardHolder, position: Int, payloads: MutableList<Any>) {
        if (payloads.isEmpty()) return onBindViewHolder(holder, position)
        val tab = tabs[position]
        if (PAYLOAD_PIN in payloads) holder.bindPin(tab)
        if (PAYLOAD_ACTIVE in payloads) holder.bindActive(tab.id == activeTabId)
    }

    /** The switcher scales and fades cards; a recycled card starts plain. */
    override fun onViewRecycled(holder: CardHolder) {
        holder.itemView.scaleX = 1f
        holder.itemView.scaleY = 1f
        holder.itemView.alpha = 1f
    }

    inner class CardHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val card: MaterialCardView = view.findViewById(R.id.tabCard)
        private val host: TextView = view.findViewById(R.id.cardHost)
        private val pin: ImageView = view.findViewById(R.id.cardPin)
        private val preview: ImageView = view.findViewById(R.id.cardPreview)
        private val titleBlock: View = view.findViewById(R.id.cardTitleBlock)
        private val title: TextView = view.findViewById(R.id.cardTitle)
        private val url: TextView = view.findViewById(R.id.cardUrl)

        init {
            preview.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitWidthFromTop() }
        }

        /** Scale the preview to the card's width, anchored at the top of the page. */
        private fun fitWidthFromTop() {
            val d = preview.drawable ?: return
            if (preview.width == 0 || d.intrinsicWidth <= 0) return
            val s = preview.width.toFloat() / d.intrinsicWidth
            preview.imageMatrix = Matrix().apply { setScale(s, s) }
        }

        private fun showPreview(shot: android.graphics.Bitmap?) {
            preview.setImageBitmap(shot)
            fitWidthFromTop()
            preview.visibility = if (shot != null) View.VISIBLE else View.GONE
            titleBlock.visibility = if (shot != null) View.GONE else View.VISIBLE
        }

        fun bind(tab: TabManager.Tab, isActive: Boolean) {
            itemView.layoutParams = itemView.layoutParams.apply { width = cardWidth }
            host.text = try { Uri.parse(tab.url).host } catch (_: Exception) { null } ?: tab.url
            bindPin(tab)

            title.text = tab.title.ifEmpty { "New Tab" }
            url.text = tab.url
            // Title card until the preview is decoded off the UI thread.
            showPreview(null)
            itemView.tag = tab.id
            TabThumbnails.load(itemView.context, tab.id) { shot ->
                if (itemView.tag == tab.id) showPreview(shot)
            }

            bindActive(isActive)

            card.setOnClickListener { onTabSelected(tab.id) }
            card.setOnLongClickListener {
                it.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                onPinToggled(tab.id)
                true
            }
        }

        fun bindPin(tab: TabManager.Tab) {
            pin.visibility = if (tab.pinned) View.VISIBLE else View.GONE
        }

        /** The current tab gets an outline in the theme's primary colour. */
        fun bindActive(isActive: Boolean) {
            card.strokeWidth = if (isActive) dp(2) else 0
            card.strokeColor = themeColor(androidx.appcompat.R.attr.colorPrimary)
        }

        private fun dp(v: Int) = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), itemView.resources.displayMetrics,
        ).toInt()

        private fun themeColor(attr: Int): Int {
            val tv = TypedValue()
            itemView.context.theme.resolveAttribute(attr, tv, true)
            return tv.data
        }
    }
}
