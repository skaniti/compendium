package dev.skaniti.compendium.adapter

import android.net.Uri
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import dev.skaniti.compendium.R
import dev.skaniti.compendium.TabManager

class TabGridAdapter(
    private var tabs: List<TabManager.Tab>,
    private val activeTabId: Int,
    private val onTabSelected: (Int) -> Unit,
    private val onTabClosed: (Int) -> Unit,
    private val onNewTab: () -> Unit
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    companion object {
        private const val TYPE_TAB = 0
        private const val TYPE_NEW = 1
    }

    override fun getItemCount(): Int = tabs.size + 1 // +1 for "New Tab" tile

    override fun getItemViewType(position: Int): Int =
        if (position < tabs.size) TYPE_TAB else TYPE_NEW

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return if (viewType == TYPE_TAB) {
            TabViewHolder(inflater.inflate(R.layout.item_tab_tile, parent, false))
        } else {
            NewTabViewHolder(inflater.inflate(R.layout.item_tab_tile, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        if (holder is TabViewHolder && position < tabs.size) {
            holder.bind(tabs[position], tabs[position].id == activeTabId)
        } else if (holder is NewTabViewHolder) {
            holder.bind()
        }
    }

    fun updateTabs(newTabs: List<TabManager.Tab>, newActiveId: Int) {
        tabs = newTabs
        notifyDataSetChanged()
    }

    inner class TabViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val title: TextView = view.findViewById(R.id.tabTitle)
        private val domain: TextView = view.findViewById(R.id.tabDomain)
        private val closeBtn: ImageButton = view.findViewById(R.id.btnCloseTab)
        private val content: LinearLayout = view.findViewById(R.id.tileContent)

        fun bind(tab: TabManager.Tab, isActive: Boolean) {
            title.text = tab.title.ifEmpty { "New Tab" }
            domain.text = try {
                Uri.parse(tab.url).host ?: ""
            } catch (_: Exception) { "" }

            // Highlight active tab via themed tile backgrounds
            content.setBackgroundResource(
                if (isActive) R.drawable.tab_tile_background_active
                else R.drawable.tab_tile_background
            )

            content.setOnClickListener { onTabSelected(tab.id) }
            closeBtn.setOnClickListener { onTabClosed(tab.id) }
        }
    }

    inner class NewTabViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val title: TextView = view.findViewById(R.id.tabTitle)
        private val domain: TextView = view.findViewById(R.id.tabDomain)
        private val closeBtn: ImageButton = view.findViewById(R.id.btnCloseTab)
        private val content: LinearLayout = view.findViewById(R.id.tileContent)

        fun bind() {
            title.text = "+ New Tab"
            title.textSize = 16f
            domain.visibility = View.GONE
            closeBtn.visibility = View.GONE
            content.setBackgroundResource(R.drawable.tab_tile_background)
            content.setOnClickListener { onNewTab() }
        }
    }
}
