package dev.skaniti.compendium

import android.content.Context
import android.os.Looper
import android.util.Log
import android.widget.Toast
import dev.skaniti.compendium.model.ExportLogEntry
import dev.skaniti.compendium.model.SessionData
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.concurrent.thread

/**
 * Hybrid session exporter: tries WiFi POST to the backend API first,
 * falls back to local JSON file if the network call fails.
 *
 * Backend endpoint: http://<laptop-ip>:8000/api/passive-captures
 * Local fallback:   getExternalFilesDir(null)/sessions/<sessionId>.json
 */
object SessionExporter {

    private const val TAG = "SessionExporter"
    private const val SESSIONS_DIR = "sessions"
    private const val EXPORT_LOG_FILE = "export_log.json"
    private const val CONNECT_TIMEOUT_MS = 3000
    private const val READ_TIMEOUT_MS = 5000

    private const val PREFS_NAME = "compendium_config"
    // Per-device backend URL lives in settings; the shipped default must
    // never point at someone's production server. Points at the compose
    // stack's host-published API port — matches the extension's own
    // localhost default (apps/extension/modules/config.js).
    private const val DEFAULT_BACKEND_URL = "http://localhost:8001"
    private const val BACKEND_ENDPOINT = "/api/passive-captures"

    // Cloudflare's Browser Integrity Check 403s bare-scripted clients
    // (python-urllib drew error 1010 during the 2026-06-10 backfill). The
    // Dalvik default UA passes today; pin a browser-shaped UA so a
    // Cloudflare settings change can't silently strand exports again.
    private const val USER_AGENT = "Mozilla/5.0 (Linux; Android; CompendiumBrowser/2.0)"

    fun getBackendUrl(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString("backend_url", DEFAULT_BACKEND_URL) ?: DEFAULT_BACKEND_URL
    }

    fun setBackendUrl(context: Context, url: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString("backend_url", url).apply()
    }

    fun getApiKey(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString("api_key", "") ?: ""
    }

    fun setApiKey(context: Context, apiKey: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString("api_key", apiKey).apply()
    }

    // Provenance seam for the device/browser-label feature (main-line task
    // #16): no UI yet; settable via adb/run-as. When set, exportSession
    // stamps it into the payload; the backend currently ignores unknown
    // fields, so this is forward-compatible.
    fun getDeviceLabel(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString("device_label", "") ?: ""
    }

    fun setDeviceLabel(context: Context, label: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString("device_label", label).apply()
    }

    private val json = Json {
        prettyPrint = true
        encodeDefaults = true
        explicitNulls = false  // unset deviceLabel is omitted, not null
    }

    /**
     * Export a session: try backend POST first, fall back to local file.
     * Runs network I/O on a background thread. Always saves locally as backup.
     */
    fun exportSession(context: Context, session: SessionData, onResult: (ExportResult) -> Unit = {}) {
        val label = getDeviceLabel(context)
        val stamped = if (label.isNotEmpty()) session.copy(deviceLabel = label) else session
        val jsonString = json.encodeToString(SessionData.serializer(), stamped)

        // Always save locally first (fast, guaranteed)
        val file = saveLocally(context, session.sessionId, jsonString)

        // Then try backend POST in background
        thread {
            val postResult = postToBackend(context, jsonString)
            val result = if (postResult.success) {
                Log.i(TAG, "Session delivered to backend: ${session.sessionId}")
                logDelivery(context, session.sessionId, session.pages.size)
                file?.delete()
                ExportResult.DELIVERED
            } else {
                Log.w(TAG, "Backend failed (${postResult.error}), saved locally: ${session.sessionId}")
                ExportResult.SAVED_LOCALLY
            }
            onResult(result)
        }
    }

    private fun saveLocally(context: Context, sessionId: String, jsonString: String): File? {
        val dir = File(context.getExternalFilesDir(null), SESSIONS_DIR)
        if (!dir.exists() && !dir.mkdirs()) {
            Log.e(TAG, "Failed to create sessions directory: $dir")
            return null
        }

        val file = File(dir, "$sessionId.json")
        return try {
            file.writeText(jsonString)
            Log.i(TAG, "Saved session locally: ${file.absolutePath}")
            file
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save session locally", e)
            null
        }
    }

    data class PostResult(val success: Boolean, val error: String? = null, val isConnectionError: Boolean = false)

    /**
     * Rewrite the local JSON format for the backend API.
     * Local files use "sessionId" (legacy naming), backend expects "captureId".
     */
    private fun rewriteForBackend(jsonString: String): String {
        return jsonString.replaceFirst("\"sessionId\"", "\"captureId\"")
    }

    // X-API-Key contract is a three-way twin: this header, buildHeaders in
    // apps/extension/modules/config.js, and verify_api_key in
    // apps/api/backend/api/main.py.
    private fun postToBackend(context: Context, jsonString: String): PostResult {
        val url = "${getBackendUrl(context)}$BACKEND_ENDPOINT"
        val apiKey = getApiKey(context)
        val body = rewriteForBackend(jsonString)
        return try {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("User-Agent", USER_AGENT)
                if (apiKey.isNotEmpty()) {
                    setRequestProperty("X-API-Key", apiKey)
                }
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
            }
            connection.outputStream.use { it.write(body.toByteArray()) }

            val code = connection.responseCode
            connection.disconnect()
            if (code in 200..299 || code == 409) {
                PostResult(success = true)
            } else {
                PostResult(success = false, error = "HTTP $code")
            }
        } catch (e: ConnectException) {
            Log.d(TAG, "Backend POST failed: ${e.message}")
            PostResult(success = false, error = "Server unreachable", isConnectionError = true)
        } catch (e: SocketTimeoutException) {
            Log.d(TAG, "Backend POST failed: ${e.message}")
            PostResult(success = false, error = "Connection timed out", isConnectionError = true)
        } catch (e: Exception) {
            Log.d(TAG, "Backend POST failed: ${e.message}")
            PostResult(success = false, error = e.message ?: "Unknown error")
        }
    }

    fun getSessionCount(context: Context): Int {
        val dir = File(context.getExternalFilesDir(null), SESSIONS_DIR)
        return dir.listFiles()?.count { it.extension == "json" } ?: 0
    }

    /**
     * Ping backend /status endpoint. Must be called from a background thread.
     * Returns null on success or an error string on failure.
     */
    fun pingBackend(context: Context): String? {
        val statusUrl = "${getBackendUrl(context)}$BACKEND_ENDPOINT/status"
        return try {
            val connection = URL(statusUrl).openConnection() as HttpURLConnection
            connection.apply {
                requestMethod = "GET"
                setRequestProperty("User-Agent", USER_AGENT)
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                val apiKey = getApiKey(context)
                if (apiKey.isNotEmpty()) {
                    setRequestProperty("X-API-Key", apiKey)
                }
            }
            val code = connection.responseCode
            connection.disconnect()
            if (code in 200..299) null else "HTTP $code"
        } catch (e: ConnectException) {
            "Unreachable"
        } catch (e: SocketTimeoutException) {
            "Timed out"
        } catch (e: Exception) {
            e.message ?: "Unknown error"
        }
    }

    fun getServerUrl(context: Context): String = "${getBackendUrl(context)}$BACKEND_ENDPOINT"

    // ---------------------------------------------------------------------
    // Export log — proof of delivery that persists after local file delete
    // ---------------------------------------------------------------------

    private val isoFormat: SimpleDateFormat
        get() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

    fun logDelivery(context: Context, sessionId: String, pageCount: Int) {
        val entry = ExportLogEntry(
            sessionId = sessionId,
            pageCount = pageCount,
            exportedAt = isoFormat.format(Date())
        )
        val logFile = File(context.getExternalFilesDir(null), EXPORT_LOG_FILE)
        val existing = readLogFile(logFile)
        val updated = existing + entry
        try {
            logFile.writeText(json.encodeToString(ListSerializer(ExportLogEntry.serializer()), updated))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write export log", e)
        }
    }

    fun getExportLog(context: Context): List<ExportLogEntry> {
        val logFile = File(context.getExternalFilesDir(null), EXPORT_LOG_FILE)
        return readLogFile(logFile)
    }

    fun getExportedCount(context: Context): Int = getExportLog(context).size

    private fun readLogFile(logFile: File): List<ExportLogEntry> {
        if (!logFile.exists()) return emptyList()
        return try {
            json.decodeFromString(ListSerializer(ExportLogEntry.serializer()), logFile.readText())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read export log", e)
            emptyList()
        }
    }

    // ---------------------------------------------------------------------
    // Batch export — used by "Export Now" button
    // ---------------------------------------------------------------------

    data class BatchResult(val exported: Int, val failed: Int, val lastError: String?)

    /**
     * Synchronous batch export — the single home of the delete-only-on-2xx/409
     * invariant (postToBackend treats 409 as success). Called directly by
     * ExportWorker (already on a background thread) and via the async wrapper
     * below for UI callers. onEach is invoked on the CALLING thread.
     */
    fun exportPendingFilesBlocking(
        context: Context,
        onEach: (sessionId: String, success: Boolean) -> Unit = { _, _ -> }
    ): BatchResult {
        val dir = File(context.getExternalFilesDir(null), SESSIONS_DIR)
        val files = dir.listFiles()?.filter { it.extension == "json" } ?: emptyList()
        var exported = 0
        var failed = 0
        var lastError: String? = null

        for (f in files) {
            val jsonString = try { f.readText() } catch (_: Exception) { failed++; continue }

            val sessionId = f.nameWithoutExtension
            val pageCount = try {
                json.decodeFromString(SessionData.serializer(), jsonString).pages.size
            } catch (_: Exception) { 0 }

            val postResult = postToBackend(context, jsonString)
            if (postResult.success) {
                logDelivery(context, sessionId, pageCount)
                f.delete()
                exported++
                onEach(sessionId, true)
            } else {
                failed++
                lastError = postResult.error
                onEach(sessionId, false)
                // Abort early if server is unreachable — no point trying remaining files
                if (postResult.isConnectionError) {
                    failed += files.size - (exported + failed)
                    break
                }
            }
        }

        return BatchResult(exported, failed, lastError)
    }

    /** Async wrapper for UI callers; callbacks land on the main thread. */
    fun exportPendingFiles(
        context: Context,
        onEach: (sessionId: String, success: Boolean) -> Unit,
        onComplete: (exported: Int, failed: Int, errorReason: String?) -> Unit
    ) {
        val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
        thread {
            val result = exportPendingFilesBlocking(context) { sessionId, success ->
                mainHandler.post { onEach(sessionId, success) }
            }
            mainHandler.post { onComplete(result.exported, result.failed, result.lastError) }
        }
    }

    /**
     * Silently flush pending exports in the background on app startup.
     * Pings the server first to avoid churning through files when offline.
     * onDone fires on the main thread after the flush attempt (or immediately
     * if there was nothing to do) — used to refresh the pending badge.
     */
    fun autoFlushPending(context: Context, onDone: () -> Unit = {}) {
        val pending = getSessionCount(context)
        if (pending == 0) {
            onDone()
            return
        }

        val mainHandler = android.os.Handler(Looper.getMainLooper())
        thread {
            if (pingBackend(context) != null) {  // server unreachable
                mainHandler.post { onDone() }
                return@thread
            }

            Log.i(TAG, "Auto-flushing $pending pending export(s)")
            exportPendingFiles(
                context = context,
                onEach = { _, _ -> },
                onComplete = { exported, failed, _ ->
                    Log.i(TAG, "Auto-flush done: $exported exported, $failed failed")
                    if (exported > 0) {
                        Toast.makeText(context, "Synced $exported session(s)", Toast.LENGTH_SHORT).show()
                    }
                    onDone()
                }
            )
        }
    }

    enum class ExportResult {
        DELIVERED,      // Backend received it, local file cleaned up
        SAVED_LOCALLY   // Server unreachable, file waiting for retry
    }
}
