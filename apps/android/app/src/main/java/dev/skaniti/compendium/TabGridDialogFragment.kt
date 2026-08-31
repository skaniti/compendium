package dev.skaniti.compendium

import android.app.Dialog
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import dev.skaniti.compendium.adapter.TabGridAdapter

/**
 * M3 bottom sheet showing a 2-column grid of open tabs.
 * Delegates tab actions back to MainActivity via [TabGridListener].
 */
class TabGridDialogFragment : BottomSheetDialogFragment() {

    interface TabGridListener {
        fun onTabSelected(tabId: Int)
        fun onTabClosed(tabId: Int)
        fun onNewTabRequested()
        fun getTabManager(): TabManager
    }

    private var listener: TabGridListener? = null

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        return inflater.inflate(R.layout.fragment_tab_grid, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        listener = activity as? TabGridListener

        val tabManager = listener?.getTabManager() ?: return

        val countLabel = view.findViewById<TextView>(R.id.tabCountLabel)
        countLabel.text = "${tabManager.tabCount} Tabs"

        val grid = view.findViewById<RecyclerView>(R.id.tabGrid)
        grid.layoutManager = GridLayoutManager(requireContext(), 2)
        grid.adapter = TabGridAdapter(
            tabs = tabManager.allTabs,
            activeTabId = tabManager.activeTabId,
            onTabSelected = { id ->
                listener?.onTabSelected(id)
                dismiss()
            },
            onTabClosed = { id ->
                listener?.onTabClosed(id)
                // Refresh grid after close
                val mgr = listener?.getTabManager() ?: return@TabGridAdapter
                if (mgr.tabCount == 0) {
                    listener?.onNewTabRequested()
                    dismiss()
                } else {
                    countLabel.text = "${mgr.tabCount} Tabs"
                    (grid.adapter as TabGridAdapter).updateTabs(mgr.allTabs, mgr.activeTabId)
                }
            },
            onNewTab = {
                listener?.onNewTabRequested()
                dismiss()
            }
        )

        view.findViewById<ImageButton>(R.id.btnCloseGrid).setOnClickListener {
            dismiss()
        }
    }
}
