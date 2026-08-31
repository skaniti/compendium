package dev.skaniti.compendium.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Data classes matching the passive session JSON schema.
 * Declaration order = serialization order. INVARIANT: sessionId stays the
 * FIRST field of SessionData — SessionExporter.rewriteForBackend (and the
 * laptop replay script) rewrite the first "sessionId" occurrence to
 * "captureId" when POSTing.
 *
 * Capture payload shape is a three-way twin: this SessionData, the
 * PassiveCaptureInput model in apps/api/backend/models/capture.py, and the
 * export payload built in apps/extension/modules/export.js.
 */

@Serializable
data class PageVisit(
    val dwellTimeSeconds: Int = 0,
    val isTrackedDomain: Boolean = false,
    val tabId: Int? = null,
    val timestamp: String,        // ISO 8601 with Z suffix
    val title: String,
    val transitionQualifiers: List<String> = emptyList(),
    val transitionType: String,
    val url: String
)

@Serializable
data class SessionData(
    val sessionId: String,
    val deviceLabel: String? = null,  // provenance seam (task #16); omitted from JSON when unset
    val startedAt: String,        // ISO 8601 with Z suffix
    val endedAt: String,          // ISO 8601 with Z suffix
    val pages: List<PageVisit>,
    val events: List<JsonObject> = emptyList(),
    val trivial: Boolean = false
)

@Serializable
data class ExportLogEntry(
    val sessionId: String,
    val pageCount: Int,
    val exportedAt: String        // ISO 8601 with Z suffix
)
