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
import dev.skaniti.compendium.gecko.CollectorPermissionDelegate
import dev.skaniti.compendium.gecko.CollectorPromptDelegate
import dev.skaniti.compendium.gecko.DownloadHelper
import dev.skaniti.compendium.gecko.GeckoEngine
import dev.skaniti.compendium.gecko.GeckoTransitionMapper
import dev.skaniti.compendium.gecko.TabsStore
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebResponse

class MainActivity : AppCompatActivity(), TabGridDialogFragment.TabGridListener, ImagePicker {

    companion object {
        private const val TAG = "MainActivity"
        private const val INACTIVITY_CHECK_INTERVAL_MS = 60_000L
        // Start page for the launch tab, the close-last-tab fallback, and every new tab (dev-note N1).
        private const val DEFAULT_URL = "https://en.wikipedia.org/"
    }

    private lateinit var urlBar: EditText
    private lateinit var webViewContainer: FrameLayout
    private lateinit var geckoView: GeckoView
    private lateinit var swipeRefresh: SwipeRefreshLayout

    private val sessionManager = SessionManager()
    private val tabManager = TabManager()

    /** Per-tab transition mappers (markers route to the active tab's). */
    private val mappers = mutableMapOf<Int, GeckoTransitionMapper>()

    private val handler = Handler(Looper.getMainLooper())
    private var lastCommittedUrl: String? = null
    private var isPageFullScreen = false

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

    private fun setFullScreenChrome(fullscreen: Boolean) {
        findViewById<View>(R.id.topBar)?.visibility = if (fullscreen) View.GONE else View.VISIBLE
        findViewById<View>(R.id.bottomBar)?.visibility = if (fullscreen) View.GONE else View.VISIBLE
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

        geckoView = GeckoView(this)
        // The default "auto" never triggers the Android Autofill framework for
        // GeckoView (Fenix forces YES for the same reason); this is what lets
        // 1Password and other system autofill services fill web forms (dev-note N3).
        geckoView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
        swipeRefresh = SwipeRefreshLayout(this).apply {
            addView(
                geckoView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                )
            )
            setOnRefreshListener {
                val tab = tabManager.activeTab()
                if (tab != null) {
                    activeMapper()?.markReload()
                    tab.session.reload()
                } else {
                    isRefreshing = false
                }
            }
        }
        webViewContainer.addView(
            swipeRefresh,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
        )

        setupNavButtons()
        setupUrlBar()
        setupMenuAndFindBar()

        sessionManager.startSession()

        val intentUrl = intent?.data?.toString()
        val snapshot = TabsStore.load(this)
        if (snapshot != null) {
            for (t in snapshot.tabs) {
                val session = GeckoSession()
                val tab = tabManager.addRestoredTab(t.id, session, t.title, t.url, t.state)
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

    override fun onStop() {
        super.onStop()
        handler.removeCallbacks(inactivityChecker)
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
        tornDown = true
        tabManager.closeAll()
        super.onDestroy()
    }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        val tab = tabManager.activeTab()
        if (isPageFullScreen && tab != null) {
            tab.session.exitFullScreen()
            return
        }
        if (tab != null && tab.canGoBack) {
            activeMapper()?.markBack()
            tab.session.goBack()
        } else {
            super.onBackPressed()
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
                    if (tab.id == tabManager.activeTabId) urlBar.setText(url)
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

            override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
                DownloadHelper.save(this@MainActivity, response)
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
                if (tab.id == tabManager.activeTabId) {
                    // Pull-to-refresh only engages at the very top of the page.
                    swipeRefresh.isEnabled = scrollY == 0 && !isPageFullScreen
                }
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
                if (url.isEmpty() || url == lastCommittedUrl) return

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
                tab.stateString = sessionState.toString()
                if (!tornDown) TabsStore.save(this@MainActivity, tabManager)
            }
        }
    }

    /** Open a session (and replay persisted state) if not yet live. */
    private fun ensureSessionOpen(tab: TabManager.Tab) {
        if (tab.session.isOpen) return
        tab.session.open(GeckoEngine.runtime(this))
        if (tab.pendingRestore && tab.stateString != null) {
            try {
                val state = GeckoSession.SessionState.fromString(tab.stateString)
                if (state != null) tab.session.restoreState(state)
            } catch (e: Exception) {
                // Corrupt state: fall back to a plain load of the last URL.
                if (tab.url.isNotEmpty()) tab.session.loadUri(tab.url)
            }
            tab.pendingRestore = false
        }
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
        TabsStore.save(this, tabManager)
    }

    fun switchToTab(tabId: Int) = switchToTab(tabId, recordSwitch = true)

    private fun switchToTab(tabId: Int, recordSwitch: Boolean) {
        val previousTabId = tabManager.activeTabId
        val tab = tabManager.switchTo(tabId) ?: return
        ensureSessionOpen(tab)

        geckoView.releaseSession()
        geckoView.setSession(tab.session)

        urlBar.setText(tab.url)
        lastCommittedUrl = tab.url

        if (recordSwitch && previousTabId != -1 && previousTabId != tabId && tab.url.isNotEmpty()) {
            sessionManager.recordPage(tab.url, tab.title, "tab_switch", emptyList(), tabId = tab.id)
        }
        TabsStore.save(this, tabManager)
    }

    fun closeTab(tabId: Int) {
        sessionManager.recordEvent("tab_closed", tabId = tabId)
        mappers.remove(tabId)

        val nextTab = tabManager.closeTab(tabId)
        if (nextTab != null) {
            switchToTab(nextTab.id)
        } else {
            createNewTab(DEFAULT_URL, isTyped = true)
        }
        TabsStore.save(this, tabManager)
    }

    private fun showTabGrid() {
        TabGridDialogFragment().show(supportFragmentManager, "tab_grid")
    }

    // -------------------------------------------------------------------------
    // TabGridListener implementation
    // -------------------------------------------------------------------------

    override fun onTabSelected(tabId: Int) = switchToTab(tabId)
    override fun onTabClosed(tabId: Int) = closeTab(tabId)
    override fun onNewTabRequested() = createNewTab(DEFAULT_URL, isTyped = true)
    override fun getTabManager(): TabManager = tabManager

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

        findViewById<ImageButton>(R.id.btnReload).setOnClickListener {
            val tab = tabManager.activeTab() ?: return@setOnClickListener
            activeMapper()?.markReload()
            tab.session.reload()
        }

        findViewById<ImageButton>(R.id.btnNewTab).setOnClickListener { createNewTab(DEFAULT_URL, isTyped = true) }
        findViewById<ImageButton>(R.id.btnTabs).setOnClickListener { showTabGrid() }
        findViewById<ImageButton>(R.id.btnHub).setOnClickListener { launchAnalysisHub() }

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
            menu.menu.add(0, 5, 4, "Settings")
            menu.menu.add(0, 6, 5, "Add note")
            menu.setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    1 -> { showFindBar(); true }
                    2 -> { toggleDesktopMode(); true }
                    3 -> { toggleBookmark(); true }
                    4 -> { startActivity(Intent(this, BookmarksActivity::class.java)); true }
                    5 -> { startActivity(Intent(this, SettingsActivity::class.java)); true }
                    6 -> { addNoteFromBrowser(); true }
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
        urlBar.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            ) {
                navigateToUrl(urlBar.text.toString())
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
