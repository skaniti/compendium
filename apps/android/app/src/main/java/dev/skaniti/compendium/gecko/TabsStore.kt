package dev.skaniti.compendium.gecko

import android.content.Context
import android.util.Log
import dev.skaniti.compendium.AtomicWrite
import dev.skaniti.compendium.TabManager
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Restart-surviving tab persistence. Written through on every
 * onSessionStateChange push (the spike showed grab-at-save lags one
 * navigation; continuous write-through is the correct pattern).
 * Small file (<= MAX_TABS entries), so whole-snapshot rewrites are fine.
 */
object TabsStore {

    private const val TAG = "TabsStore"
    private const val FILE_NAME = "tabs.json"

    @Serializable
    data class TabSnapshot(
        val id: Int,
        val title: String,
        val url: String,
        val state: String? = null,
    )

    @Serializable
    data class TabsSnapshot(
        val activeTabId: Int,
        val tabs: List<TabSnapshot>,
    )

    private val json = Json { ignoreUnknownKeys = true }

    fun snapshotOf(manager: TabManager): TabsSnapshot =
        TabsSnapshot(
            activeTabId = manager.activeTabId,
            tabs = manager.allTabs.map {
                TabSnapshot(it.id, it.title, it.url, it.stateString)
            },
        )

    /** A zero-tab snapshot is never legitimate (closing the last tab creates a new one). */
    fun shouldPersist(snapshot: TabsSnapshot): Boolean = snapshot.tabs.isNotEmpty()

    fun decodeResult(text: String): Result<TabsSnapshot> = runCatching { decode(text) }

    fun save(context: Context, manager: TabManager) {
        val snapshot = snapshotOf(manager)
        if (!shouldPersist(snapshot)) {
            Log.w(TAG, "Skipping zero-tab snapshot (teardown or transient state)")
            return
        }
        try {
            AtomicWrite.write(file(context), json.encodeToString(TabsSnapshot.serializer(), snapshot))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to persist tabs", e)
        }
    }

    fun load(context: Context): TabsSnapshot? {
        val f = file(context)
        if (!f.exists()) {
            Log.i(TAG, "No tabs on disk; starting fresh")
            return null
        }
        val text = try {
            f.readText()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read tabs; starting fresh", e)
            return null
        }
        val snap = decodeResult(text).getOrElse { e ->
            Log.e(TAG, "Failed to parse tabs (${text.length} chars); starting fresh", e)
            return null
        }
        // Tabs with neither a URL nor saved state restore as blank husks
        // (e.g. persisted by a run that died before any navigation) —
        // drop them; an empty result means start fresh.
        val worthRestoring = snap.tabs.filter { it.url.isNotEmpty() || it.state != null }
        Log.i(TAG, "Restored ${worthRestoring.size} tab(s) (${snap.tabs.size} on disk)")
        return if (worthRestoring.isEmpty()) null else snap.copy(tabs = worthRestoring)
    }

    fun encode(snapshot: TabsSnapshot): String =
        json.encodeToString(TabsSnapshot.serializer(), snapshot)

    fun decode(text: String): TabsSnapshot =
        json.decodeFromString(TabsSnapshot.serializer(), text)

    private fun file(context: Context) = File(context.filesDir, FILE_NAME)
}
