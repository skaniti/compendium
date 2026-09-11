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

    fun save(context: Context, manager: TabManager) {
        try {
            AtomicWrite.write(file(context), json.encodeToString(TabsSnapshot.serializer(), snapshotOf(manager)))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to persist tabs", e)
        }
    }

    fun load(context: Context): TabsSnapshot? {
        val f = file(context)
        if (!f.exists()) return null
        return try {
            val snap = json.decodeFromString(TabsSnapshot.serializer(), f.readText())
            // Tabs with neither a URL nor saved state restore as blank husks
            // (e.g. persisted by a run that died before any navigation) —
            // drop them; an empty result means start fresh.
            val worthRestoring = snap.tabs.filter { it.url.isNotEmpty() || it.state != null }
            if (worthRestoring.isEmpty()) null
            else snap.copy(tabs = worthRestoring)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load tabs; starting fresh", e)
            null
        }
    }

    fun encode(snapshot: TabsSnapshot): String =
        json.encodeToString(TabsSnapshot.serializer(), snapshot)

    fun decode(text: String): TabsSnapshot =
        json.decodeFromString(TabsSnapshot.serializer(), text)

    private fun file(context: Context) = File(context.filesDir, FILE_NAME)
}
