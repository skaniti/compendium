package dev.skaniti.compendium

import dev.skaniti.compendium.model.PageVisit
import dev.skaniti.compendium.model.SessionData
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Manages session state: page recording, dwell time backfill, session boundaries.
 *
 * Session lifecycle:
 *   startSession() → recordPage() per navigation → finalizeSession() → SessionData
 *
 * Dwell time is computed retroactively: when page N+1 arrives, page N's dwell time
 * is set to (now - page N's timestamp).
 */
class SessionManager {

    companion object {
        private val TRACKED_DOMAINS = listOf(
            "wikipedia.org",
            "youtube.com",
            "reddit.com",
            "stackoverflow.com",
            "arxiv.org"
        )

        private const val TRIVIAL_THRESHOLD = 3
        private const val INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000L // 30 minutes

        private val ISO_FORMATTER: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
                .withZone(ZoneOffset.UTC)

        private val JSON = Json { prettyPrint = true; encodeDefaults = true }
    }

    private var sessionId: String = ""
    private var startedAt: Instant = Instant.now()
    private var lastActivityTime: Instant = Instant.now()
    private val pages: MutableList<PageVisit> = mutableListOf()
    private val events: MutableList<JsonObject> = mutableListOf()
    private var currentPageTimestamp: Instant? = null

    val pageCount: Int get() = pages.size
    val isActive: Boolean get() = sessionId.isNotEmpty()

    fun startSession() {
        val now = Instant.now()
        val suffix = generateSuffix()
        // Epoch-ms prefix = extension id parity, zone-free. The backend keys
        // source detection ONLY on the trailing "_mobile" (rsplit), so the
        // prefix format is free to match the extension's.
        sessionId = "${now.toEpochMilli()}_${suffix}_mobile"
        startedAt = now
        lastActivityTime = now
        pages.clear()
        events.clear()
        currentPageTimestamp = null
    }

    /**
     * Record a structured event (tab_created, tab_closed, etc.).
     */
    fun recordEvent(type: String, tabId: Int? = null, extra: Map<String, String> = emptyMap()) {
        val event = buildJsonObject {
            put("type", type)
            put("timestamp", ISO_FORMATTER.format(Instant.now()))
            if (tabId != null) put("tabId", tabId)
            for ((k, v) in extra) put(k, v)
        }
        events.add(event)
    }

    /**
     * Record a page visit. Backfills the previous page's dwell time.
     */
    fun recordPage(url: String, title: String, transitionType: String, qualifiers: List<String>, tabId: Int? = null) {
        val now = Instant.now()

        // Backfill previous page's dwell time
        backfillDwellTime(now)

        val page = PageVisit(
            dwellTimeSeconds = 0,  // backfilled when next page arrives or session finalizes
            isTrackedDomain = isTrackedDomain(url),
            tabId = tabId,
            timestamp = ISO_FORMATTER.format(now),
            title = title,
            transitionQualifiers = qualifiers,
            transitionType = transitionType,
            url = url
        )

        pages.add(page)
        currentPageTimestamp = now
        lastActivityTime = now
    }

    /**
     * Finalize the current session and return the SessionData.
     * Backfills the last page's dwell time before returning.
     */
    fun finalizeSession(): SessionData? {
        if (pages.isEmpty()) return null

        val now = Instant.now()
        backfillDwellTime(now)

        val data = SessionData(
            sessionId = sessionId,
            startedAt = ISO_FORMATTER.format(startedAt),
            endedAt = ISO_FORMATTER.format(now),
            pages = pages.toList(),
            events = events.toList(),
            trivial = pages.size < TRIVIAL_THRESHOLD
        )

        // Reset for next session
        sessionId = ""
        pages.clear()
        events.clear()
        currentPageTimestamp = null

        return data
    }

    /**
     * Check if the session has timed out due to inactivity.
     */
    fun isTimedOut(): Boolean {
        return Instant.now().toEpochMilli() - lastActivityTime.toEpochMilli() > INACTIVITY_TIMEOUT_MS
    }

    fun touchActivity() {
        lastActivityTime = Instant.now()
    }

    /**
     * Return a JSON snapshot of the current session (for the analysis hub).
     */
    fun currentSessionJson(): String {
        val now = Instant.now()
        val snapshot = SessionData(
            sessionId = sessionId,
            startedAt = ISO_FORMATTER.format(startedAt),
            endedAt = ISO_FORMATTER.format(now),
            pages = pages.toList(),
            events = events.toList(),
            trivial = pages.size < TRIVIAL_THRESHOLD
        )
        return JSON.encodeToString(SessionData.serializer(), snapshot)
    }

    fun getPages(): List<PageVisit> = pages.toList()

    private fun backfillDwellTime(now: Instant) {
        if (pages.isNotEmpty() && currentPageTimestamp != null) {
            val lastIndex = pages.lastIndex
            val dwellSeconds = ((now.toEpochMilli() - currentPageTimestamp!!.toEpochMilli()) / 1000).toInt()
            pages[lastIndex] = pages[lastIndex].copy(dwellTimeSeconds = dwellSeconds)
        }
    }

    private fun isTrackedDomain(url: String): Boolean {
        return try {
            val host = java.net.URI(url).host ?: return false
            TRACKED_DOMAINS.any { domain -> host.contains(domain) }
        } catch (e: Exception) {
            false
        }
    }

    private fun generateSuffix(): String {
        val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        return (1..9).map { chars.random() }.joinToString("")
    }
}
