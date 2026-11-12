package dev.skaniti.compendium

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import dev.skaniti.compendium.gecko.BookmarkStore
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import dev.skaniti.compendium.gecko.CollectorPermissionDelegate
import dev.skaniti.compendium.gecko.CollectorPromptDelegate
import dev.skaniti.compendium.gecko.DownloadHelper
import dev.skaniti.compendium.gecko.GeckoEngine
import dev.skaniti.compendium.gecko.GeckoTransitionMapper
import dev.skaniti.compendium.gecko.PullRefreshGeckoView
import dev.skaniti.compendium.gecko.TabThumbnails
import dev.skaniti.compendium.gecko.TabsStore
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.MediaSession
import org.mozilla.geckoview.WebResponse
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity(), TabSwitcherDialogFragment.TabSwitcherListener, ImagePicker {

    companion object {
        private const val TAG = "MainActivity"
        private const val INACTIVITY_CHECK_INTERVAL_MS = 60_000L
        // Session-state pushes arrive on every navigation of every live tab; coalesce the
        // whole-snapshot rewrite of tabs.json instead of writing on each one.
        private const val TABS_SAVE_DELAY_MS = 1_000L
        // Close all keeps the closed tabs' previews until its Undo snackbar is dismissed;
        // this backstop covers a switcher that goes away first.
        private const val CLOSE_ALL_UNDO_BACKSTOP_MS = 60_000L
        // The switcher opens after the visible tab's preview is captured, or after this long.
        private const val PREVIEW_CAPTURE_WAIT_MS = 500L
        // Start page for the launch tab, the close-last-tab fallback, and every new tab (dev-note N1).
        private const val DEFAULT_URL = "https://en.wikipedia.org/"
    }

    private lateinit var urlBar: EditText
    private lateinit var webViewContainer: FrameLayout
    private lateinit var geckoView: PullRefreshGeckoView
    private lateinit var swipeRefresh: SwipeRefreshLayout

    private val sessionManager = SessionManager()
    private val tabManager = TabManager()

    /** Per-tab transition mappers (markers route to the active tab's). */
    private val mappers = mutableMapOf<Int, GeckoTransitionMapper>()

    private val handler = Handler(Looper.getMainLooper())
    private var lastCommittedUrl: String? = null
    private var isPageFullScreen = false
    private var imeVisible = false

    /** Set before sessions are closed so a late state callback cannot persist an empty tab list. */
    private var tornDown = false

    private val inactivityChecker = object : Runnable {
        override fun run() {
            if (sessionManager.isActive && sessionManager.isTimedOut()) {
                exportAndRestart()
            }
            handler.postDelayed(this, INACTIVITY_CHECK_INTERVAL_MS)
        }
    }

    // tabs.json is a whole-snapshot rewrite that grows with the tab count: snapshot on the
    // UI thread, encode and write on one background thread so writes stay in order.
    private val tabsWriter = Executors.newSingleThreadExecutor()
    private var tabsSavePending = false
    private val saveTabs = Runnable { tabsSavePending = false; saveTabsNow() }

    private fun saveTabsNow() {
        if (tornDown) return
        val snapshot = TabsStore.snapshotOf(tabManager)
        tabsWriter.execute { TabsStore.write(this, snapshot) }
    }

    /**
     * Coalesce session-state pushes: in the foreground at most one write per
     * TABS_SAVE_DELAY_MS (the timer is not restarted, so a page that pushes constantly is
     * still saved); in the background at once, since the process can be killed any time.
     */
    private fun scheduleTabsSave() {
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            handler.removeCallbacks(saveTabs)
            tabsSavePending = false
            saveTabsNow()
            return
        }
        if (tabsSavePending) return
        tabsSavePending = true
        handler.postDelayed(saveTabs, TABS_SAVE_DELAY_MS)
    }

    /** Write the current snapshot now and wait (bounded) for the writer to drain. */
    private fun flushTabs() {
        handler.removeCallbacks(saveTabs)
        tabsSavePending = false
        saveTabsNow()
        try {
            tabsWriter.submit {}.get(2, TimeUnit.SECONDS)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Tab save did not finish in time", e)
        }
    }

    private fun activeMapper(): GeckoTransitionMapper? =
        tabManager.activeTab()?.let { mappers[it.id] }

    // --- Activity-result plumbing for prompt/permission delegates (W2) ---

    private var pendingFilePick: ((Array<android.net.Uri>?) -> Unit)? = null
    private val filePickLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val cb = pendingFilePick
            pendingFilePick = null
            if (res.resultCode == RESULT_OK && res.data != null) {
                val data = res.data!!
                val uris = data.clipData?.let { cd ->
                    Array(cd.itemCount) { cd.getItemAt(it).uri }
                } ?: data.data?.let { arrayOf(it) }
                cb?.invoke(uris)
            } else {
                cb?.invoke(null)
            }
        }

    private var pendingPermCb: ((Boolean) -> Unit)? = null
    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            val cb = pendingPermCb
            pendingPermCb = null
            cb?.invoke(grants.isNotEmpty() && grants.values.all { it })
        }

    // Gallery picker for note screenshots (ImagePicker).
    private var pendingImagePick: ((Uri?) -> Unit)? = null
    private val getContentLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            val cb = pendingImagePick
            pendingImagePick = null
            cb?.invoke(uri)
        }

    override fun pickImage(onPicked: (Uri?) -> Unit) {
        pendingImagePick = onPicked
        getContentLauncher.launch("image/*")
    }

    private val promptDelegate by lazy {
        CollectorPromptDelegate(this, object : CollectorPromptDelegate.FilePickerBridge {
            override fun pickFiles(intent: Intent, onResult: (Array<android.net.Uri>?) -> Unit) {
                pendingFilePick = onResult
                filePickLauncher.launch(intent)
            }
        })
    }

    private val permissionDelegate by lazy {
        CollectorPermissionDelegate(this, object : CollectorPermissionDelegate.RuntimePermissionBridge {
            override fun request(permissions: Array<String>, onResult: (Boolean) -> Unit) {
                pendingPermCb = onResult
                permLauncher.launch(permissions)
            }
        })
    }

    /** The bottom bar gives way to page fullscreen and to the soft keyboard. */
    private fun updateBottomBar() {
        findViewById<View>(R.id.bottomBar)?.visibility =
            if (isPageFullScreen || imeVisible) View.GONE else View.VISIBLE
    }

    private fun setFullScreenChrome(fullscreen: Boolean) {
        findViewById<View>(R.id.topBar)?.visibility = if (fullscreen) View.GONE else View.VISIBLE
        updateBottomBar()
        swipeRefresh.isEnabled = !fullscreen
        val controller = WindowCompat.getInsetsController(window, geckoView)
        if (fullscreen) {
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        urlBar = findViewById(R.id.urlBar)
        webViewContainer = findViewById(R.id.webViewContainer)

        geckoView = PullRefreshGeckoView(this)
        // The default "auto" never triggers the Android Autofill framework for
        // GeckoView (Fenix forces YES for the same reason); this is what lets
        // 1Password and other system autofill services fill web forms (dev-note N3).
        geckoView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
        // The keyboard resizes the window (adjustResize in the manifest); the bottom bar
        // steps aside so the page reaches down to the keyboard. GeckoView owns the root
        // view's insets listener, so observe through it instead of replacing it.
        geckoView.addWindowInsetsListener("bottom-bar-ime") { _, insets ->
            val visible = insets.isVisible(WindowInsetsCompat.Type.ime())
            if (visible != imeVisible) {
                android.util.Log.i(TAG, "imeVisible=$visible")
                imeVisible = visible
                updateBottomBar()
                // Keyboard dismissed without Go: let the next tap on the bar select all again.
                if (!visible && urlBar.hasFocus()) geckoView.requestFocus()
            }
            insets
        }
        swipeRefresh = SwipeRefreshLayout(this).apply {
            addView(
                geckoView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                )
            )
            // Pull-to-refresh engages only when Gecko says the gesture can overscroll the
            // page at its top (see PullRefreshGeckoView).
            setOnChildScrollUpCallback { _, _ -> !geckoView.canPullToRefresh() }
            setOnRefreshListener {
                if (tabManager.activeTab() != null) reloadActiveTab() else isRefreshing = false
            }
        }
        webViewContainer.addView(
            swipeRefresh,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
        )

        // The page starts with focus; the URL bar, as the first focusable view, would
        // otherwise take it and keep its address from following navigation.
        geckoView.requestFocus()

        setupNavButtons()
        setupUrlBar()
        setupMenuAndFindBar()

        sessionManager.startSession()

        val intentUrl = intent?.data?.toString()
        val snapshot = TabsStore.load(this)
        if (snapshot != null) {
            for (t in snapshot.tabs) {
                val session = GeckoSession()
                val tab = tabManager.addRestoredTab(t.id, session, t.title, t.url, t.state, t.pinned)
                wireSessionDelegates(tab)
            }
            val activeId = snapshot.tabs.find { it.id == snapshot.activeTabId }?.id
                ?: snapshot.tabs.first().id
            if (intentUrl != null) {
                createNewTab(intentUrl, isTyped = true)
            } else {
                switchToTab(activeId, recordSwitch = false)
            }
        } else {
            createNewTab(intentUrl ?: DEFAULT_URL, isTyped = true)
        }
        TabThumbnails.prune(this, tabManager.allTabs.map { it.id }.toSet())

        handler.postDelayed(inactivityChecker, INACTIVITY_CHECK_INTERVAL_MS)

        // Auto-flush any pending exports from previous sessions
        SessionExporter.autoFlushPending(this) { refreshPendingBadge() }

        // First-run prompt: no api key configured -> open settings.
        if (SessionExporter.getApiKey(this).isEmpty()) {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val url = intent.data?.toString() ?: return
        createNewTab(url, isTyped = true)
    }

    override fun onStart() {
        super.onStart()
        // The visible tab's content process may have been killed while in the background.
        restoreActiveIfClosed()
    }

    override fun onPause() {
        super.onPause()
        // Keep the visible tab's switcher preview current.
        captureActivePreview()
    }

    override fun onStop() {
        super.onStop()
        handler.removeCallbacks(inactivityChecker)
        // A backgrounded process can be killed at any time.
        flushTabs()
        exportSession()
    }

    override fun onRestart() {
        super.onRestart()
        sessionManager.startSession()
        lastCommittedUrl = null
        handler.postDelayed(inactivityChecker, INACTIVITY_CHECK_INTERVAL_MS)
    }

    override fun onResume() {
        super.onResume()
        refreshPendingBadge()
    }

    override fun onDestroy() {
        handler.removeCallbacks(inactivityChecker)
        handler.removeCallbacks(finalizeCloseAll)
        // Last write while the tab list is still whole; afterwards tornDown blocks all saves.
        flushTabs()
        tornDown = true
        tabManager.closeAll()
        tabsWriter.shutdown()
        super.onDestroy()
    }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        val tab = tabManager.activeTab()
        when (BackPolicy.decide(tab != null, isPageFullScreen, tab?.canGoBack == true)) {
            BackPolicy.Action.EXIT_FULLSCREEN -> tab?.session?.exitFullScreen()
            BackPolicy.Action.GO_BACK -> {
                activeMapper()?.markBack()
                tab?.session?.goBack()
            }
            // finish() would drop the task and its tabs from recents
            BackPolicy.Action.MOVE_TO_BACKGROUND -> moveTaskToBack(true)
        }
    }

    /** Undelivered-session count on the Hub button; hidden at zero. */
    private fun refreshPendingBadge() {
        val badge = findViewById<TextView>(R.id.hubPendingBadge) ?: return
        val pending = SessionExporter.getSessionCount(this)
        badge.visibility = if (pending > 0) View.VISIBLE else View.GONE
        if (pending > 0) badge.text = if (pending > 99) "99+" else pending.toString()
    }

    // -------------------------------------------------------------------------
    // Session creation + capture delegates
    // -------------------------------------------------------------------------

    private fun wireSessionDelegates(tab: TabManager.Tab) {
        val mapper = mappers.getOrPut(tab.id) { GeckoTransitionMapper() }
        val s = tab.session

        s.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onLocationChange(
                session: GeckoSession,
                url: String?,
                perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>,
                hasUserGesture: Boolean,
            ) {
                if (url != null && url != "about:blank") {
                    tab.url = url
                    mapper.onLocationChanged()
                    if (tab.id == tabManager.activeTabId && !urlBar.hasFocus()) urlBar.setText(url)
                }
            }

            override fun onLoadRequest(
                session: GeckoSession,
                request: GeckoSession.NavigationDelegate.LoadRequest,
            ): GeckoResult<AllowOrDeny>? {
                mapper.onLoadRequest(request.hasUserGesture, request.isRedirect)
                return GeckoResult.fromValue(AllowOrDeny.ALLOW)
            }

            override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
                tab.canGoBack = canGoBack
            }

            override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) {
                tab.canGoForward = canGoForward
            }
        }

        s.historyDelegate = object : GeckoSession.HistoryDelegate {
            override fun onVisited(
                session: GeckoSession,
                url: String,
                lastVisitedURL: String?,
                flags: Int,
            ): GeckoResult<Boolean>? {
                mapper.onVisited()
                return GeckoResult.fromValue(true)
            }
        }

        s.promptDelegate = promptDelegate
        // Playing media keeps a tab from being suspended (see suspendIdleTabs).
        s.mediaSessionDelegate = object : MediaSession.Delegate {
            override fun onActivated(session: GeckoSession, mediaSession: MediaSession) {
                android.util.Log.i(TAG, "media active tab=${tab.id}")
                tab.mediaActive = true
            }

            override fun onDeactivated(session: GeckoSession, mediaSession: MediaSession) {
                tab.mediaActive = false
            }
        }
        s.permissionDelegate = permissionDelegate

        s.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onTitleChange(session: GeckoSession, title: String?) {
                if (title != null) tab.title = title
            }

            override fun onFullScreen(session: GeckoSession, fullScreen: Boolean) {
                android.util.Log.i(TAG, "onFullScreen=$fullScreen tab=${tab.id}")
                if (tab.id == tabManager.activeTabId) {
                    isPageFullScreen = fullScreen
                    setFullScreenChrome(fullScreen)
                }
            }

            override fun onKill(session: GeckoSession) {
                android.util.Log.i(TAG, "onKill tab=${tab.id}")
                onContentProcessGone(tab, restoreNow = true)
            }

            override fun onCrash(session: GeckoSession) {
                android.util.Log.w(TAG, "onCrash tab=${tab.id}")
                onContentProcessGone(tab, restoreNow = false)
            }

            override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
                // A tab with a download streaming is not suspended (see suspendIdleTabs).
                tab.downloadsInFlight++
                DownloadHelper.save(this@MainActivity, response) { tab.downloadsInFlight-- }
            }

            override fun onContextMenu(
                session: GeckoSession,
                screenX: Int,
                screenY: Int,
                element: GeckoSession.ContentDelegate.ContextElement,
            ) {
                val linkUri = element.linkUri ?: return
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Link options")
                    .setItems(arrayOf("Open in new tab")) { _, _ ->
                        createNewTab(linkUri)
                    }
                    .show()
            }
        }

        s.scrollDelegate = object : GeckoSession.ScrollDelegate {
            override fun onScrollChanged(session: GeckoSession, scrollX: Int, scrollY: Int) {
                tab.scrollY = scrollY
            }
        }

        s.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStop(session: GeckoSession, success: Boolean) {
                if (tab.id == tabManager.activeTabId) swipeRefresh.isRefreshing = false
                if (!success) return
                // Parity with the WebView app: record only the ACTIVE tab's
                // loads; background-tab pages get recorded via tab_switch.
                if (tab.id != tabManager.activeTabId) return
                val url = tab.url
                if (url.isEmpty() || url == lastCommittedUrl) {
                    // Not a new visit (restore, reload, same page): drop the signals it left
                    // so they cannot mislabel the next navigation.
                    mapper.consume()
                    return
                }

                lastCommittedUrl = url
                val (transitionType, qualifiers) = mapper.consume()
                sessionManager.recordPage(
                    url,
                    tab.title.ifEmpty { url },
                    transitionType,
                    qualifiers,
                    tabId = tab.id,
                )
                sessionManager.touchActivity()
            }

            override fun onSessionStateChange(
                session: GeckoSession,
                sessionState: GeckoSession.SessionState,
            ) {
                // A suspended tab keeps the state it was suspended with; a late callback from
                // the closing session must not overwrite it.
                if (tab.pendingRestore) return
                tab.stateString = sessionState.toString()
                tab.stateUrl = sessionState.getOrNull(sessionState.currentIndex)?.uri
                if (!tornDown) scheduleTabsSave()
            }
        }
    }

    /** Open a session (and replay persisted state) if not yet live. */
    private fun ensureSessionOpen(tab: TabManager.Tab) {
        if (tab.session.isOpen) return
        tab.session.open(GeckoEngine.runtime(this))
        if (tab.pendingRestore) {
            val state = try {
                tab.stateString?.let { GeckoSession.SessionState.fromString(it) }
            } catch (e: Exception) {
                null
            }
            // No or corrupt state: fall back to a plain load of the last URL.
            if (state != null) tab.session.restoreState(state)
            else if (tab.url.isNotEmpty()) tab.session.loadUri(tab.url)
            tab.pendingRestore = false
        }
    }

    /**
     * Close the sessions of tabs beyond the live budget; each restores from its saved
     * state when opened again. A tab with no saved state yet stays live.
     */
    private fun suspendIdleTabs() {
        for (tab in tabManager.idleLiveTabs(TabManager.MAX_LIVE_TABS)) {
            // Saved state that trails the page (a push still in flight) would restore the
            // wrong page; playing media or a streaming download would be cut off.
            if (tab.stateString == null || tab.stateUrl != tab.url) continue
            if (tab.mediaActive || tab.downloadsInFlight > 0) continue
            android.util.Log.i(TAG, "suspend tab=${tab.id}")
            tab.pendingRestore = true
            tab.session.close()
        }
    }

    /**
     * The tab's content process is gone and GeckoView has closed its session; its saved
     * state is kept for a restore. After an OS kill the visible tab restores at once if the
     * app is in the foreground (else on the next start); after a crash it waits for a reload
     * or a switch, so a page that crashes on load cannot loop.
     */
    private fun onContentProcessGone(tab: TabManager.Tab, restoreNow: Boolean) {
        if (tornDown) return
        tab.pendingRestore = true
        if (tab.id != tabManager.activeTabId) return
        if (isPageFullScreen) {
            isPageFullScreen = false
            setFullScreenChrome(false)
        }
        if (restoreNow && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            handler.post { restoreActiveIfClosed() }
        }
    }

    /** Reopen the visible tab if its session was closed underneath it (kill or crash). */
    private fun restoreActiveIfClosed() {
        if (tornDown) return
        val tab = tabManager.activeTab() ?: return
        if (!tab.session.isOpen) switchToTab(tab.id, recordSwitch = false)
    }

    /** Reload the visible tab, or restore it if its content process crashed. */
    private fun reloadActiveTab() {
        val tab = tabManager.activeTab() ?: return
        if (!tab.session.isOpen) {
            switchToTab(tab.id, recordSwitch = false)
            return
        }
        activeMapper()?.markReload()
        tab.session.reload()
    }

    // -------------------------------------------------------------------------
    // Tab management
    // -------------------------------------------------------------------------

    private fun createNewTab(url: String? = null, isTyped: Boolean = false) {
        if (tabManager.tabCount >= TabManager.MAX_TABS) {
            Toast.makeText(this, "Max ${TabManager.MAX_TABS} tabs", Toast.LENGTH_SHORT).show()
            return
        }

        val session = GeckoSession()
        val tab = tabManager.createTab(session) ?: return
        wireSessionDelegates(tab)
        ensureSessionOpen(tab)
        sessionManager.recordEvent("tab_created", tabId = tab.id)

        switchToTab(tab.id, recordSwitch = false)

        if (url != null) {
            if (isTyped) mappers[tab.id]?.markTyped()
            session.loadUri(url)
        }
        saveTabsNow()
    }

    fun switchToTab(tabId: Int) = switchToTab(tabId, recordSwitch = true)

    private fun switchToTab(tabId: Int, recordSwitch: Boolean) {
        val previousTabId = tabManager.activeTabId
        val tab = tabManager.switchTo(tabId) ?: return
        ensureSessionOpen(tab)

        geckoView.releaseSession()
        geckoView.setSession(tab.session)
        suspendIdleTabs()

        urlBar.setText(tab.url)
        lastCommittedUrl = tab.url

        if (recordSwitch && previousTabId != -1 && previousTabId != tabId && tab.url.isNotEmpty()) {
            sessionManager.recordPage(tab.url, tab.title, "tab_switch", emptyList(), tabId = tab.id)
        }
        saveTabsNow()
    }

    fun closeTab(tabId: Int) {
        if (tabManager.tabById(tabId) == null) return
        sessionManager.recordEvent("tab_closed", tabId = tabId)
        mappers.remove(tabId)
        TabThumbnails.delete(this, tabId)

        val nextTab = tabManager.closeTab(tabId)
        if (nextTab != null) {
            switchToTab(nextTab.id)
        } else {
            createNewTab(DEFAULT_URL, isTyped = true)
        }
        saveTabsNow()
    }

    /** True from a Tabs tap until its switcher shows, so a second tap cannot open another. */
    private var switcherOpening = false

    private fun showTabSwitcher() {
        if (switcherOpening || supportFragmentManager.findFragmentByTag("tab_switcher") != null) return
        switcherOpening = true
        captureActivePreview {
            switcherOpening = false
            if (!isFinishing && !supportFragmentManager.isStateSaved &&
                supportFragmentManager.findFragmentByTag("tab_switcher") == null
            ) {
                TabSwitcherDialogFragment().show(supportFragmentManager, "tab_switcher")
            }
        }
    }

    /**
     * Capture the visible tab as its switcher preview, then run [then]. A capture that
     * fails or takes longer than PREVIEW_CAPTURE_WAIT_MS never holds [then] back.
     */
    private fun captureActivePreview(then: () -> Unit = {}) {
        val tab = tabManager.activeTab()
        if (tab == null || !tab.session.isOpen) {
            then()
            return
        }
        var done = false
        val finish = {
            if (!done) {
                done = true
                then()
            }
        }
        handler.postDelayed({ finish() }, PREVIEW_CAPTURE_WAIT_MS)
        try {
            geckoView.capturePixels().accept({ bitmap ->
                // A late capture for a tab closed meanwhile must not leave a preview behind.
                if (bitmap != null && !tornDown && tabManager.tabById(tab.id) != null) {
                    TabThumbnails.save(this, tab.id, bitmap)
                }
                finish()
            }, { finish() })
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Preview capture failed", e)
            finish()
        }
    }

    // -------------------------------------------------------------------------
    // TabSwitcherListener implementation
    // -------------------------------------------------------------------------

    override fun onTabSelected(tabId: Int) = switchToTab(tabId)
    override fun onTabClosed(tabId: Int) = closeTab(tabId)
    override fun onNewTabRequested() = createNewTab(DEFAULT_URL, isTyped = true)
    override fun getTabManager(): TabManager = tabManager

    override fun onTabPinToggled(tabId: Int) {
        val tab = tabManager.tabById(tabId) ?: return
        tab.pinned = !tab.pinned
        saveTabsNow()
    }

    /**
     * Close all batches Undo can still bring back, oldest first; each holds (index in
     * the tab list at the time, tab). Undo replays them newest first, so every index
     * refers to the list it was taken from.
     */
    private val closeAllBatches = mutableListOf<List<Pair<Int, TabsStore.TabSnapshot>>>()

    /** Start-page tabs Close all opened because nothing was left; Undo drops them if untouched. */
    private val closeAllFallbackIds = mutableSetOf<Int>()

    /** Undo can no longer happen: drop the closed tabs' previews. */
    private val finalizeCloseAll = Runnable {
        closeAllBatches.flatten().forEach { (_, snap) -> TabThumbnails.delete(this, snap.id) }
        closeAllBatches.clear()
        closeAllFallbackIds.clear()
    }

    override fun onCloseUnpinned(): Int {
        val tabs = tabManager.allTabs
        val ids = unpinnedTabIds(tabs.map { it.id to it.pinned }).toSet()
        if (ids.isEmpty()) return 0

        // A state that trails the page (a push still in flight) would reopen the older
        // page; restore those from the URL instead.
        closeAllBatches += tabs.withIndex()
            .filter { it.value.id in ids }
            .map { (index, t) ->
                val state = if (t.stateUrl == null || t.stateUrl == t.url) t.stateString else null
                index to TabsStore.TabSnapshot(t.id, t.title, t.url, state)
            }
        val activeBefore = tabManager.activeTabId
        for (id in ids) {
            sessionManager.recordEvent("tab_closed", tabId = id)
            mappers.remove(id)
            tabManager.closeTab(id)
        }
        val active = tabManager.activeTab()
        when {
            active == null -> {
                createNewTab(DEFAULT_URL, isTyped = true)
                tabManager.activeTab()?.let { closeAllFallbackIds += it.id }
            }
            active.id != activeBefore -> switchToTab(active.id, recordSwitch = false)
        }
        saveTabsNow()
        // Backstop for when the switcher goes away before its Undo snackbar is dismissed.
        handler.removeCallbacks(finalizeCloseAll)
        handler.postDelayed(finalizeCloseAll, CLOSE_ALL_UNDO_BACKSTOP_MS)
        return ids.size
    }

    override fun onUndoCloseAll(): Int {
        handler.removeCallbacks(finalizeCloseAll)
        // Start-page tabs Close all opened go once the closed tabs are back, unless used meanwhile.
        val fallbacks = closeAllFallbackIds.mapNotNull { tabManager.tabById(it) }.filter { !it.canGoBack }
        closeAllFallbackIds.clear()

        var room = (TabManager.MAX_TABS - tabManager.tabCount + fallbacks.size).coerceAtLeast(0)
        var reopened = 0
        var lost = 0
        for (batch in closeAllBatches.asReversed()) {
            val sorted = batch.sortedBy { it.first }
            val restored = sorted.take(room).map { (index, snap) ->
                val tab = tabManager.restoredTab(snap.id, GeckoSession(), snap.title, snap.url, snap.state)
                wireSessionDelegates(tab)
                sessionManager.recordEvent("tab_reopened", tabId = tab.id)
                index to tab
            }
            sorted.drop(room).forEach { (_, snap) -> TabThumbnails.delete(this, snap.id) }
            tabManager.reinsertTabs(restored)
            room -= restored.size
            reopened += restored.size
            lost += batch.size - restored.size
        }
        closeAllBatches.clear()

        for (tab in fallbacks) {
            if (tabManager.tabCount <= 1) break
            sessionManager.recordEvent("tab_closed", tabId = tab.id)
            mappers.remove(tab.id)
            tabManager.closeTab(tab.id)
            TabThumbnails.delete(this, tab.id)
        }
        // Keep the view on an open session of the active tab (closing a fallback moves it).
        val active = tabManager.activeTab() ?: tabManager.allTabs.firstOrNull()
        if (active != null && (active.id != tabManager.activeTabId || !active.session.isOpen ||
                geckoView.session !== active.session)
        ) {
            switchToTab(active.id, recordSwitch = false)
        }
        saveTabsNow()
        if (lost > 0) {
            Toast.makeText(this, "Reopened $reopened tabs; $lost over the ${TabManager.MAX_TABS}-tab limit", Toast.LENGTH_LONG).show()
        }
        return reopened
    }

    override fun onCloseAllUndoExpired() {
        handler.removeCallbacks(finalizeCloseAll)
        finalizeCloseAll.run()
    }

    // -------------------------------------------------------------------------
    // Navigation buttons
    // -------------------------------------------------------------------------

    private fun setupNavButtons() {
        findViewById<ImageButton>(R.id.btnBack).setOnClickListener {
            val tab = tabManager.activeTab() ?: return@setOnClickListener
            if (tab.canGoBack) {
                activeMapper()?.markBack()
                tab.session.goBack()
            }
        }

        findViewById<ImageButton>(R.id.btnForward).setOnClickListener {
            val tab = tabManager.activeTab() ?: return@setOnClickListener
            if (tab.canGoForward) {
                activeMapper()?.markForward()
                tab.session.goForward()
            }
        }

        findViewById<ImageButton>(R.id.btnReload).setOnClickListener { reloadActiveTab() }

        findViewById<ImageButton>(R.id.btnNewTab).setOnClickListener { createNewTab(DEFAULT_URL, isTyped = true) }
        findViewById<ImageButton>(R.id.btnTabs).setOnClickListener { showTabSwitcher() }
        findViewById<ImageButton>(R.id.btnHub).setOnClickListener { launchAnalysisHub() }
        findViewById<ImageButton>(R.id.btnSettings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        // Long-press Hub opens settings.
        findViewById<ImageButton>(R.id.btnHub).setOnLongClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
            true
        }
    }

    // -------------------------------------------------------------------------
    // W3: overflow menu, find-in-page, desktop mode, bookmarks
    // -------------------------------------------------------------------------

    private fun setupMenuAndFindBar() {
        findViewById<ImageButton>(R.id.btnMenu).setOnClickListener { anchor ->
            val tab = tabManager.activeTab()
            val menu = PopupMenu(this, anchor)
            menu.menu.add(0, 1, 0, "Find in page")
            menu.menu.add(0, 2, 1, if (tab?.desktopMode == true) "Mobile site" else "Desktop site")
            val bookmarked = tab != null && tab.url.isNotEmpty() &&
                BookmarkStore.isBookmarked(this, tab.url)
            menu.menu.add(0, 3, 2, if (bookmarked) "Remove bookmark" else "Add bookmark")
            menu.menu.add(0, 4, 3, "Bookmarks")
            menu.menu.add(0, 6, 4, "Add note")
            menu.menu.add(0, 7, 5, "Open in Chrome")
            menu.setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    1 -> { showFindBar(); true }
                    2 -> { toggleDesktopMode(); true }
                    3 -> { toggleBookmark(); true }
                    4 -> { startActivity(Intent(this, BookmarksActivity::class.java)); true }
                    6 -> { addNoteFromBrowser(); true }
                    7 -> {
                        if (!ExternalBrowser.openInChrome(this, tab?.url)) {
                            Toast.makeText(this, "No web page to open", Toast.LENGTH_SHORT).show()
                        }
                        true
                    }
                    else -> false
                }
            }
            menu.show()
        }

        val findInput = findViewById<EditText>(R.id.findInput)
        findInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) { findNext(false); true } else false
        }
        findViewById<ImageButton>(R.id.btnFindNext).setOnClickListener { findNext(false) }
        findViewById<ImageButton>(R.id.btnFindPrev).setOnClickListener { findNext(true) }
        findViewById<ImageButton>(R.id.btnFindClose).setOnClickListener { hideFindBar() }
    }

    private fun showFindBar() {
        findViewById<View>(R.id.findBar).visibility = View.VISIBLE
        findViewById<EditText>(R.id.findInput).requestFocus()
    }

    private fun hideFindBar() {
        findViewById<View>(R.id.findBar).visibility = View.GONE
        tabManager.activeTab()?.session?.finder?.clear()
    }

    private fun findNext(backwards: Boolean) {
        val tab = tabManager.activeTab() ?: return
        val query = findViewById<EditText>(R.id.findInput).text.toString()
        if (query.isEmpty()) return
        val flags = if (backwards) GeckoSession.FINDER_FIND_BACKWARDS else 0
        tab.session.finder.find(query, flags)
    }

    private fun toggleDesktopMode() {
        val tab = tabManager.activeTab() ?: return
        tab.desktopMode = !tab.desktopMode
        tab.session.settings.userAgentMode =
            if (tab.desktopMode) GeckoSessionSettings.USER_AGENT_MODE_DESKTOP
            else GeckoSessionSettings.USER_AGENT_MODE_MOBILE
        tab.session.settings.viewportMode =
            if (tab.desktopMode) GeckoSessionSettings.VIEWPORT_MODE_DESKTOP
            else GeckoSessionSettings.VIEWPORT_MODE_MOBILE
        activeMapper()?.markReload()
        tab.session.reload()
    }

    private fun toggleBookmark() {
        val tab = tabManager.activeTab() ?: return
        if (tab.url.isEmpty()) return
        val added = BookmarkStore.toggle(this, tab.url, tab.title, System.currentTimeMillis())
        Toast.makeText(this, if (added) "Bookmarked" else "Bookmark removed", Toast.LENGTH_SHORT).show()
    }

    private fun addNoteFromBrowser() {
        val tab = tabManager.activeTab()
        val shot = java.io.File(dev.skaniti.compendium.gecko.NotesStore.dir(this), ".pending-shot.png")
        ScreenshotCapture.captureWindow(this, shot) { ok ->
            NoteDialog.show(
                activity = this, picker = this, existing = null,
                autoShot = if (ok) shot else null,
                activeUrl = tab?.url, activeTitle = tab?.title,
                onSaved = { Toast.makeText(this, "Note saved", Toast.LENGTH_SHORT).show() },
            )
        }
    }

    private fun setupUrlBar() {
        // Leaving the bar without Go puts the page's address back over any half-typed text.
        urlBar.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) tabManager.activeTab()?.let { urlBar.setText(it.url) }
        }
        urlBar.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            ) {
                navigateToUrl(urlBar.text.toString())
                // Move focus to the page so the next tap on the bar selects the whole address again.
                geckoView.requestFocus()
                getSystemService(InputMethodManager::class.java)
                    ?.hideSoftInputFromWindow(urlBar.windowToken, 0)
                true
            } else {
                false
            }
        }
    }

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    private fun navigateToUrl(input: String) {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return

        val url = if (trimmed.contains("://")) {
            trimmed
        } else if (trimmed.contains(".") && !trimmed.contains(" ")) {
            "https://$trimmed"
        } else {
            SettingsActivity.searchUrlFor(this, trimmed)
        }

        val tab = tabManager.activeTab() ?: return
        activeMapper()?.markTyped()
        tab.session.loadUri(url)
    }

    // -------------------------------------------------------------------------
    // Session management
    // -------------------------------------------------------------------------

    private fun exportSession() {
        val data = sessionManager.finalizeSession() ?: return
        SessionExporter.exportSession(this, data)
    }

    private fun exportAndRestart() {
        val data = sessionManager.finalizeSession()
        if (data != null) {
            val pageCount = data.pages.size
            SessionExporter.exportSession(this, data) { result ->
                val msg = when (result) {
                    SessionExporter.ExportResult.DELIVERED -> "Sent $pageCount pages to server"
                    SessionExporter.ExportResult.SAVED_LOCALLY -> "Saved $pageCount pages locally"
                }
                handler.post {
                    Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
                    refreshPendingBadge()
                }
            }
        }

        sessionManager.startSession()
        lastCommittedUrl = null
    }

    // -------------------------------------------------------------------------
    // Analysis Hub
    // -------------------------------------------------------------------------

    private fun launchAnalysisHub() {
        val intent = Intent(this, AnalysisActivity::class.java)
        intent.putExtra("sessionJson", sessionManager.currentSessionJson())
        intent.putExtra("tabCount", tabManager.tabCount)
        intent.putExtra("exportedCount", SessionExporter.getExportedCount(this))
        intent.putExtra("activeUrl", tabManager.activeTab()?.url ?: "")
        intent.putExtra("activeTitle", tabManager.activeTab()?.title ?: "")
        startActivity(intent)
    }
}
