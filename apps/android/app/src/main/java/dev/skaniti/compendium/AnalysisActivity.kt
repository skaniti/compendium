package dev.skaniti.compendium

import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.bottomnavigation.BottomNavigationView
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContracts
import dev.skaniti.compendium.gecko.NotesStore
import dev.skaniti.compendium.model.ExportLogEntry
import dev.skaniti.compendium.model.SessionData
import kotlinx.serialization.json.Json
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AnalysisActivity : AppCompatActivity(), ImagePicker {

    private lateinit var hubContent: FrameLayout
    private var sessionJson: String = ""
    private var tabCount: Int = 0
    private var activeUrl: String = ""
    private var activeTitle: String = ""

    private var pendingPick: ((Uri?) -> Unit)? = null
    private val getContentLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            val cb = pendingPick; pendingPick = null; cb?.invoke(uri)
        }

    override fun pickImage(onPicked: (Uri?) -> Unit) {
        pendingPick = onPicked
        getContentLauncher.launch("image/*")
    }

    private val json = Json { ignoreUnknownKeys = true }

    // Resolved from the app theme so the hub follows Material You / dark mode
    // like the rest of the app (was a hardcoded purple palette).
    private fun themeColor(attrRes: Int): Int {
        val tv = TypedValue()
        theme.resolveAttribute(attrRes, tv, true)
        return tv.data
    }
    private val cSurfaceContainer by lazy { themeColor(com.google.android.material.R.attr.colorSurfaceContainerHighest) }
    private val cPrimary by lazy { themeColor(androidx.appcompat.R.attr.colorPrimary) }
    private val cOnPrimary by lazy { themeColor(com.google.android.material.R.attr.colorOnPrimary) }
    private val cOnSurface by lazy { themeColor(com.google.android.material.R.attr.colorOnSurface) }
    private val cOnSurfaceVariant by lazy { themeColor(com.google.android.material.R.attr.colorOnSurfaceVariant) }
    private val cOutline by lazy { themeColor(com.google.android.material.R.attr.colorOutline) }

    // Phone tab toggle state
    private enum class PhoneCard { SESSION_PAGES, LOCAL_FILES }
    private var phoneSelectedCard = PhoneCard.LOCAL_FILES

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_analysis)

        sessionJson = intent.getStringExtra("sessionJson") ?: ""
        tabCount = intent.getIntExtra("tabCount", 0)
        activeUrl = intent.getStringExtra("activeUrl") ?: ""
        activeTitle = intent.getStringExtra("activeTitle") ?: ""

        hubContent = findViewById(R.id.hubContent)

        findViewById<ImageButton>(R.id.btnBackToMain).setOnClickListener { finish() }

        val bottomNav = findViewById<BottomNavigationView>(R.id.hubBottomNav)
        bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_phone -> { showPhoneSection(); true }
                R.id.nav_laptop -> { showLaptopSection(); true }
                R.id.nav_notes -> { showNotesSection(); true }
                else -> false
            }
        }

        // Default to Phone tab
        showPhoneSection()
    }

    // -------------------------------------------------------------------------
    // Phone tab — toggle cards: session pages vs local files
    // -------------------------------------------------------------------------

    private fun showPhoneSection() {
        hubContent.removeAllViews()

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        }

        val session = tryParseSession()
        val pageCount = session?.pages?.size ?: 0
        val localFileCount = SessionExporter.getSessionCount(this)

        // Toggle cards row
        val cardsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = linearParams(matchWidth = true)
        }

        val cardA = createToggleCard(
            "$pageCount", "pages\nin this session",
            selected = phoneSelectedCard == PhoneCard.SESSION_PAGES
        )
        cardA.setOnClickListener {
            phoneSelectedCard = PhoneCard.SESSION_PAGES
            showPhoneSection()
        }

        val cardB = createToggleCard(
            "$localFileCount", "sessions\nin local storage",
            selected = phoneSelectedCard == PhoneCard.LOCAL_FILES
        )
        cardB.setOnClickListener {
            phoneSelectedCard = PhoneCard.LOCAL_FILES
            showPhoneSection()
        }

        cardsRow.addView(cardA, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).also {
            it.marginEnd = dp(8)
        })
        cardsRow.addView(cardB, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        container.addView(cardsRow)

        // Detail area based on selection
        when (phoneSelectedCard) {
            PhoneCard.SESSION_PAGES -> {
                container.addView(createSectionHeader("Current session ($tabCount tabs)"))
                if (session != null && session.pages.isNotEmpty()) {
                    val pageList = LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = linearParams(matchWidth = true)
                        setPadding(0, 0, 0, dp(8))
                    }
                    val inflater = LayoutInflater.from(this)
                    for ((i, page) in session.pages.withIndex()) {
                        val row = inflater.inflate(R.layout.item_page_visit, pageList, false)
                        row.findViewById<TextView>(R.id.pageIndex).text = "${i + 1}"
                        row.findViewById<TextView>(R.id.pageTitle).text = page.title
                        val tabLabel = if (page.tabId != null) " [tab ${page.tabId}]" else ""
                        row.findViewById<TextView>(R.id.pageTransition).text = page.transitionType + tabLabel
                        row.isClickable = false
                        row.isFocusable = false
                        pageList.addView(row)
                    }
                    container.addView(pageList)
                } else {
                    container.addView(createSubtext("No pages yet"))
                }
            }
            PhoneCard.LOCAL_FILES -> {
                container.addView(createSectionHeader("Local session files"))
                val sessionsDir = File(getExternalFilesDir(null), "sessions")
                val files = sessionsDir.listFiles()?.filter { it.extension == "json" }
                    ?.sortedByDescending { it.lastModified() } ?: emptyList()

                if (files.isEmpty()) {
                    container.addView(createSubtext("No local session files"))
                } else {
                    for (f in files) {
                        val fileCard = createFileCard(f)
                        fileCard.setOnClickListener { showSessionSummaryDialog(f) }
                        container.addView(fileCard)
                    }
                }
            }
        }

        // Cache path at bottom
        val sessionsDir = File(getExternalFilesDir(null), "sessions")
        container.addView(createSectionHeader("Cache path"))
        container.addView(createSubtext(sessionsDir.absolutePath))

        hubContent.addView(container)
    }

    private fun showSessionSummaryDialog(file: File) {
        val data = try {
            json.decodeFromString(SessionData.serializer(), file.readText())
        } catch (_: Exception) {
            null
        }

        val message = if (data != null) {
            buildString {
                appendLine("Session: ${data.sessionId}")
                appendLine("Pages: ${data.pages.size}")
                appendLine("Start: ${data.startedAt}")
                appendLine("End: ${data.endedAt}")
                if (data.pages.isNotEmpty()) {
                    appendLine()
                    appendLine("Pages visited:")
                    for ((i, p) in data.pages.withIndex()) {
                        appendLine("  ${i + 1}. ${p.title}")
                    }
                }
            }
        } else {
            "Could not parse session file."
        }

        AlertDialog.Builder(this)
            .setTitle("Session Summary")
            .setMessage(message)
            .setPositiveButton("OK", null)
            .show()
    }

    // -------------------------------------------------------------------------
    // Laptop tab — connection status, Export Now, export log
    // -------------------------------------------------------------------------

    private fun showLaptopSection() {
        hubContent.removeAllViews()

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        }

        // Connection status — two separate checks: WiFi and Server
        container.addView(createSectionHeader("Connection"))

        // Row 1: WiFi status
        val wifiName = getWifiName()
        val hasWifi = checkNetworkAvailable()
        val wifiLabel = if (hasWifi) {
            if (wifiName != null) "WiFi: $wifiName" else "WiFi: connected"
        } else {
            "WiFi: not connected"
        }
        container.addView(createStatusRow(wifiLabel, ok = hasWifi))

        // Row 2: Server status — starts as "checking...", updated by background ping
        val serverUrl = SessionExporter.getBackendUrl(this)
        val serverRow = createStatusRow("Server: checking...", ok = null)
        container.addView(serverRow)
        container.addView(createSubtext(serverUrl))

        // Ping server in background
        val handler = Handler(Looper.getMainLooper())
        kotlin.concurrent.thread {
            val error = SessionExporter.pingBackend(this)
            handler.post {
                val dot = serverRow.getChildAt(0)
                val label = serverRow.getChildAt(1) as TextView
                if (error == null) {
                    dot.setBackgroundColor(0xFF4CAF50.toInt())
                    label.text = "Server: running"
                } else {
                    dot.setBackgroundColor(0xFFFF5252.toInt())
                    label.text = "Server: $error"
                }
            }
        }

        // Export Now button
        val pendingCount = SessionExporter.getSessionCount(this)
        val exportBtn = TextView(this).apply {
            text = if (pendingCount > 0) "Export Now ($pendingCount pending)" else "Export Now"
            setTextColor(cOnPrimary)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(12), dp(16), dp(12))
            background = GradientDrawable().apply {
                setColor(cPrimary)
                cornerRadius = dp(12).toFloat()
            }
            layoutParams = linearParams(matchWidth = true).also {
                (it as LinearLayout.LayoutParams).topMargin = dp(16)
                it.bottomMargin = dp(16)
            }
        }

        exportBtn.setOnClickListener {
            if (pendingCount == 0) {
                exportBtn.text = "No pending files"
                return@setOnClickListener
            }
            exportBtn.isEnabled = false
            exportBtn.text = "Exporting 0/$pendingCount..."

            var progressCount = 0
            SessionExporter.exportPendingFiles(
                context = this,
                onEach = { _, _ ->
                    progressCount++
                    exportBtn.text = "Exporting $progressCount/$pendingCount..."
                },
                onComplete = { exported, failed, errorReason ->
                    exportBtn.isEnabled = true
                    exportBtn.text = when {
                        failed == 0 -> "Done! $exported exported"
                        exported == 0 && errorReason != null -> "$failed failed — $errorReason"
                        errorReason != null -> "$exported exported, $failed failed — $errorReason"
                        else -> "$exported exported, $failed failed"
                    }
                    // Refresh the export log below
                    refreshExportLog(container)
                }
            )
        }
        container.addView(exportBtn)

        // Export log
        container.addView(createSectionHeader("Export log"))
        addExportLogEntries(container)

        hubContent.addView(container)
    }

    private fun addExportLogEntries(container: LinearLayout) {
        val log = SessionExporter.getExportLog(this).sortedByDescending { it.exportedAt }

        if (log.isEmpty()) {
            container.addView(createSubtext("No exports recorded yet").apply { tag = "export_log_entry" })
        } else {
            for (entry in log) {
                container.addView(createExportLogCard(entry).apply { tag = "export_log_entry" })
            }
        }
    }

    private fun refreshExportLog(container: LinearLayout) {
        // Remove old export log entries
        val toRemove = mutableListOf<View>()
        for (i in 0 until container.childCount) {
            val child = container.getChildAt(i)
            if (child.tag == "export_log_entry") toRemove.add(child)
        }
        toRemove.forEach { container.removeView(it) }

        // Re-add updated log
        addExportLogEntries(container)
    }

    // -------------------------------------------------------------------------
    // Notes tab
    // -------------------------------------------------------------------------

    private fun showNotesSection() {
        hubContent.removeAllViews()
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT)
        }

        val newBtn = TextView(this).apply {
            text = "New note"
            setTextColor(cOnPrimary); textSize = 16f; typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(12), dp(16), dp(12))
            background = GradientDrawable().apply { setColor(cPrimary); cornerRadius = dp(12).toFloat() }
            layoutParams = linearParams(matchWidth = true).also {
                (it as LinearLayout.LayoutParams).topMargin = dp(8); it.bottomMargin = dp(8)
            }
        }
        newBtn.setOnClickListener {
            NoteDialog.show(this, this, null, null, activeUrl, activeTitle) { showNotesSection() }
        }
        container.addView(newBtn)

        NotesStore.drainStatusInbox(this)
        val notes = NotesStore.all(this).sortedByDescending { it.updatedAtMs ?: it.createdAtMs }
        container.addView(createSectionHeader("Notes (${notes.count { it.status == NotesStore.STATUS_OPEN }} open)"))
        if (notes.isEmpty()) {
            container.addView(createSubtext("No notes yet"))
        } else {
            for (n in notes) container.addView(createNoteCard(n))
        }
        hubContent.addView(container)
    }

    private fun createNoteCard(note: NotesStore.Note): LinearLayout {
        val dateFmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedSurface()
            setPadding(dp(12), dp(8), dp(12), dp(8))
            isClickable = true; isFocusable = true
            layoutParams = linearParams(matchWidth = true).also {
                (it as LinearLayout.LayoutParams).bottomMargin = dp(8)
            }
            val typeTag = "[${note.type}]" + if (note.status == NotesStore.STATUS_DONE) " (done)" else ""
            addView(TextView(this@AnalysisActivity).apply {
                text = "$typeTag ${note.text}"
                setTextColor(cOnSurface); textSize = 14f; maxLines = 3
            })
            addView(TextView(this@AnalysisActivity).apply {
                val ctx = note.pageTitle ?: note.url ?: ""
                text = listOf(ctx, dateFmt.format(Date(note.createdAtMs)))
                    .filter { it.isNotEmpty() }.joinToString("  |  ")
                setTextColor(cOnSurfaceVariant); textSize = 11f
            })
            if (note.status == NotesStore.STATUS_DONE &&
                (note.resolvedCommit != null || note.resolutionNote != null)
            ) {
                addView(TextView(this@AnalysisActivity).apply {
                    val parts = mutableListOf("✓ done")
                    note.resolvedCommit?.let { parts.add("fixed in $it") }
                    note.resolutionNote?.let { parts.add(it) }
                    note.resolvedAt?.let { parts.add(dateFmt.format(Date(it))) }
                    text = parts.joinToString("  ·  ")
                    setTextColor(cPrimary); textSize = 11f
                })
            }
            setOnClickListener { showNoteActions(note) }
        }
    }

    private fun showNoteActions(note: NotesStore.Note) {
        val doneLabel = if (note.status == NotesStore.STATUS_DONE) "Reopen" else "Mark done"
        AlertDialog.Builder(this)
            .setTitle(note.text.take(60))
            .setItems(arrayOf("Edit", doneLabel, "Delete")) { _, which ->
                when (which) {
                    0 -> NoteDialog.show(this, this, note, null, activeUrl, activeTitle) { showNotesSection() }
                    1 -> {
                        val next = if (note.status == NotesStore.STATUS_DONE) NotesStore.STATUS_OPEN else NotesStore.STATUS_DONE
                        NotesStore.setStatus(this, note.id, next); showNotesSection()
                    }
                    2 -> { NotesStore.deleteNote(this, note.id); showNotesSection() }
                }
            }
            .show()
    }

    // -------------------------------------------------------------------------
    // View factory helpers
    // -------------------------------------------------------------------------

    private fun createToggleCard(number: String, label: String, selected: Boolean): LinearLayout {
        val borderColor = if (selected) cPrimary else cOutline
        val bg = GradientDrawable().apply {
            setColor(cSurfaceContainer)
            setStroke(dp(2), borderColor)
            cornerRadius = dp(8).toFloat()
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            background = bg
            setPadding(dp(16), dp(16), dp(16), dp(16))
            isClickable = true
            isFocusable = true
            addView(TextView(this@AnalysisActivity).apply {
                text = number
                setTextColor(if (selected) cPrimary else cOnSurfaceVariant)
                textSize = 36f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
            })
            addView(TextView(this@AnalysisActivity).apply {
                text = label
                setTextColor(cOnSurfaceVariant)
                textSize = 12f
                gravity = Gravity.CENTER
            })
        }
    }

    private fun createFileCard(file: File): LinearLayout {
        val dateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
        val pageCount = try {
            json.decodeFromString(SessionData.serializer(), file.readText()).pages.size
        } catch (_: Exception) { -1 }

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedSurface()
            setPadding(dp(12), dp(8), dp(12), dp(8))
            isClickable = true
            isFocusable = true
            layoutParams = linearParams(matchWidth = true).also {
                (it as LinearLayout.LayoutParams).bottomMargin = dp(8)
            }
            addView(TextView(this@AnalysisActivity).apply {
                text = file.nameWithoutExtension
                setTextColor(cOnSurface)
                textSize = 13f
                typeface = Typeface.DEFAULT_BOLD
            })
            addView(TextView(this@AnalysisActivity).apply {
                val info = buildString {
                    if (pageCount >= 0) append("$pageCount pages  |  ")
                    append(dateFormat.format(Date(file.lastModified())))
                }
                text = info
                setTextColor(cOnSurfaceVariant)
                textSize = 11f
            })
        }
    }

    /** Rounded surface-container background for cards. */
    private fun roundedSurface(): GradientDrawable = GradientDrawable().apply {
        setColor(cSurfaceContainer)
        cornerRadius = dp(12).toFloat()
    }

    private fun createExportLogCard(entry: ExportLogEntry): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedSurface()
            setPadding(dp(12), dp(8), dp(12), dp(8))
            layoutParams = linearParams(matchWidth = true).also {
                (it as LinearLayout.LayoutParams).bottomMargin = dp(8)
            }
            addView(TextView(this@AnalysisActivity).apply {
                text = entry.sessionId
                setTextColor(cOnSurface)
                textSize = 13f
                typeface = Typeface.DEFAULT_BOLD
            })
            addView(TextView(this@AnalysisActivity).apply {
                text = "${entry.pageCount} pages  |  ${entry.exportedAt}"
                setTextColor(cOnSurfaceVariant)
                textSize = 11f
            })
        }
    }

    private fun tryParseSession(): SessionData? {
        return try {
            json.decodeFromString(SessionData.serializer(), sessionJson)
        } catch (_: Exception) {
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun getWifiName(): String? {
        return try {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val info = wifiManager.connectionInfo
            val ssid = info.ssid
            if (ssid != null && ssid != "<unknown ssid>") {
                ssid.trim('"')
            } else null
        } catch (_: Exception) {
            null
        }
    }

    private fun checkNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    private fun createStatusRow(text: String, ok: Boolean?): LinearLayout {
        val dotColor = when (ok) {
            true -> 0xFF4CAF50.toInt()   // green
            false -> 0xFFFF5252.toInt()   // red
            null -> 0xFFFF9800.toInt()    // amber (pending)
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = linearParams(matchWidth = true)
            setPadding(0, dp(4), 0, dp(4))
            addView(View(this@AnalysisActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).also {
                    it.marginEnd = dp(8)
                }
                setBackgroundColor(dotColor)
            })
            addView(TextView(this@AnalysisActivity).apply {
                this.text = text
                setTextColor(cOnSurface)
                textSize = 14f
            })
        }
    }

    private fun createSectionHeader(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(cOnSurface)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, dp(16), 0, dp(8))
        }
    }

    private fun createSubtext(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(cOnSurfaceVariant)
            textSize = 12f
            setPadding(0, dp(2), 0, dp(2))
        }
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics
        ).toInt()
    }

    private fun linearParams(matchWidth: Boolean): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(
            if (matchWidth) LinearLayout.LayoutParams.MATCH_PARENT else LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
    }
}
