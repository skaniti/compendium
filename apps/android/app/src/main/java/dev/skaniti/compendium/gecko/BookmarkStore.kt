package dev.skaniti.compendium.gecko

import android.content.Context
import android.util.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Bookmarks-only store (NO history — user decision 2026-06-10), JSON file via
 * kotlinx-serialization (deliberate simplification from the spec's Room
 * suggestion: zero new deps at this scale). Export = Netscape bookmark HTML,
 * the universal browser-import format.
 */
object BookmarkStore {

    private const val TAG = "BookmarkStore"
    private const val FILE_NAME = "bookmarks.json"

    @Serializable
    data class Bookmark(val url: String, val title: String, val addedAtMs: Long)

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }

    fun all(context: Context): List<Bookmark> {
        val f = file(context)
        if (!f.exists()) return emptyList()
        return try {
            json.decodeFromString<List<Bookmark>>(f.readText())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read bookmarks", e)
            emptyList()
        }
    }

    fun isBookmarked(context: Context, url: String): Boolean =
        all(context).any { it.url == url }

    /** Returns true if the URL is bookmarked AFTER the toggle. */
    fun toggle(context: Context, url: String, title: String, nowMs: Long): Boolean {
        val current = all(context)
        val existing = current.filter { it.url != url }
        val added = existing.size == current.size
        val next = if (added) current + Bookmark(url, title.ifEmpty { url }, nowMs) else existing
        save(context, next)
        return added
    }

    fun remove(context: Context, url: String) =
        save(context, all(context).filter { it.url != url })

    fun exportNetscapeHtml(bookmarks: List<Bookmark>): String = buildString {
        appendLine("<!DOCTYPE NETSCAPE-Bookmark-file-1>")
        appendLine("<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">")
        appendLine("<TITLE>Bookmarks</TITLE>")
        appendLine("<H1>Bookmarks</H1>")
        appendLine("<DL><p>")
        for (b in bookmarks) {
            val secs = b.addedAtMs / 1000
            appendLine("    <DT><A HREF=\"${escape(b.url)}\" ADD_DATE=\"$secs\">${escape(b.title)}</A>")
        }
        appendLine("</DL><p>")
    }

    private fun escape(s: String) = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    private fun save(context: Context, bookmarks: List<Bookmark>) {
        try {
            file(context).writeText(
                json.encodeToString(
                    kotlinx.serialization.builtins.ListSerializer(Bookmark.serializer()),
                    bookmarks,
                )
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save bookmarks", e)
        }
    }

    private fun file(context: Context) = File(context.filesDir, FILE_NAME)
}
