package dev.skaniti.compendium

import org.mozilla.geckoview.GeckoSession

/** A tab whose GeckoSession is open, with the sequence number of its last activation. */
internal data class LiveTab(val id: Int, val lastActive: Long)

/**
 * Tabs to suspend so at most [maxLive] sessions stay open: the least recently
 * used ones beyond the budget, never the active tab.
 */
internal fun idleTabsToSuspend(live: List<LiveTab>, activeId: Int, maxLive: Int): List<Int> {
    if (live.size <= maxLive) return emptyList()
    val keep = live.filter { it.id != activeId }
        .sortedByDescending { it.lastActive }
        .take(maxLive - 1)
        .map { it.id }
        .toSet() + activeId
    return live.map { it.id }.filter { it !in keep }
}

/**
 * Manages tab lifecycle: create, switch, close, update info.
 * Each tab owns a GeckoSession; one shared GeckoView renders the active one.
 * Detached sessions keep running (the Fenix model), but only the
 * [MAX_LIVE_TABS] most recently used stay open; the rest are suspended and
 * restored from saved state when opened again.
 */
class TabManager {

    companion object {
        const val MAX_TABS = 50
        const val MAX_LIVE_TABS = 4
    }

    data class Tab(
        val id: Int,
        val session: GeckoSession,
        var title: String = "New Tab",
        var url: String = "",
        /** Serialized GeckoSession.SessionState, persisted write-through. */
        var stateString: String? = null,
        /** True when recreated from disk and not yet opened/restored. */
        var pendingRestore: Boolean = false,
        var canGoBack: Boolean = false,
        var canGoForward: Boolean = false,
        var desktopMode: Boolean = false,
        var scrollY: Int = 0,
        /** Activation sequence number; higher = used more recently. */
        var lastActive: Long = 0,
        /** URL of the current entry in [stateString], to spot state that trails the page. */
        var stateUrl: String? = null,
        var mediaActive: Boolean = false,
        var downloadsInFlight: Int = 0,
    )

    private val tabs = mutableListOf<Tab>()
    private var nextId = 1
    private var activations = 0L
    var activeTabId: Int = -1
        private set

    val tabCount: Int get() = tabs.size
    val allTabs: List<Tab> get() = tabs.toList()

    fun activeTab(): Tab? = tabs.find { it.id == activeTabId }
    fun tabById(tabId: Int): Tab? = tabs.find { it.id == tabId }

    /** Create a new tab. Returns null if at max capacity. */
    fun createTab(session: GeckoSession): Tab? {
        if (tabs.size >= MAX_TABS) return null
        val tab = Tab(id = nextId++, session = session)
        tabs.add(tab)
        return tab
    }

    /** Recreate a tab from persisted state (launch-restore path). */
    fun addRestoredTab(
        id: Int,
        session: GeckoSession,
        title: String,
        url: String,
        stateString: String?,
    ): Tab {
        val tab = Tab(
            id = id, session = session, title = title, url = url,
            stateString = stateString,
            // A tab saved before its first state push still reloads its URL.
            pendingRestore = stateString != null || url.isNotEmpty(),
        )
        tabs.add(tab)
        if (id >= nextId) nextId = id + 1
        return tab
    }

    fun switchTo(tabId: Int): Tab? {
        val tab = tabs.find { it.id == tabId } ?: return null
        activeTabId = tabId
        tab.lastActive = ++activations
        return tab
    }

    /** Open-session tabs beyond the [maxLive] budget, least recently used first. */
    fun idleLiveTabs(maxLive: Int): List<Tab> {
        val live = tabs.filter { it.session.isOpen }.map { LiveTab(it.id, it.lastActive) }
        return idleTabsToSuspend(live, activeTabId, maxLive).mapNotNull { tabById(it) }
    }

    /**
     * Close a tab and its session. Returns the tab to switch to
     * (nearest neighbor, or null if none remain).
     */
    fun closeTab(tabId: Int): Tab? {
        val index = tabs.indexOfFirst { it.id == tabId }
        if (index == -1) return null

        val removed = tabs.removeAt(index)
        removed.session.close()

        if (tabs.isEmpty()) return null

        if (activeTabId == tabId) {
            val newIndex = (index - 1).coerceAtLeast(0)
            activeTabId = tabs[newIndex].id
            return tabs[newIndex]
        }
        return activeTab()
    }

    fun updateInfo(tabId: Int, title: String? = null, url: String? = null) {
        val tab = tabs.find { it.id == tabId } ?: return
        if (title != null) tab.title = title
        if (url != null) tab.url = url
    }

    fun closeAll() {
        tabs.forEach { it.session.close() }
        tabs.clear()
        activeTabId = -1
    }
}
