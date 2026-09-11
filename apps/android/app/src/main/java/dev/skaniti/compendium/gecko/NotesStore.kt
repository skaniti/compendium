package dev.skaniti.compendium.gecko

import android.content.Context
import android.util.Log
import dev.skaniti.compendium.AtomicWrite
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Dev-notes store (app issues/improvements jotted while browsing). Mirrors
 * [BookmarkStore]: one @Serializable class + one JSON file via
 * kotlinx-serialization, zero new deps. Lives in the EXTERNAL files dir so
 * Claude Code can `adb pull` it without run-as (same dir family as sessions/).
 *
 * Pure list transforms (with*) are unit-tested; the Context-bound shell is
 * verified on-device (no Robolectric in the test classpath).
 */
object NotesStore {

    private const val TAG = "NotesStore"
    private const val DIR_NAME = "dev-notes"
    private const val FILE_NAME = "notes.json"
    private const val INBOX_NAME = ".status-inbox.jsonl"
    private const val PROCESSING_NAME = ".status-inbox.processing"

    const val TYPE_ISSUE = "issue"
    const val TYPE_IMPROVEMENT = "improvement"
    const val STATUS_OPEN = "open"
    const val STATUS_DONE = "done"

    @Serializable
    data class Note(
        val id: String,
        val createdAtMs: Long,
        val text: String,
        val type: String,                 // issue | improvement
        val status: String = STATUS_OPEN, // open | done
        val url: String? = null,
        val pageTitle: String? = null,
        val appVersion: String = "",
        val device: String = "",
        val androidApi: Int = 0,
        val screenshot: String? = null,   // "<id>.png" or null
        val updatedAtMs: Long? = null,
        val resolvedCommit: String? = null,
        val resolvedAt: Long? = null,
        val resolutionNote: String? = null,
    )

    @Serializable
    data class StatusCommand(
        val id: String,
        val status: String,                  // "done" | "open"
        val resolvedCommit: String? = null,
        val resolvedAt: Long? = null,
        val resolutionNote: String? = null,
    )

    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    // ---- pure transforms (unit-tested) ----

    fun withAdded(list: List<Note>, note: Note): List<Note> = list + note

    fun withUpdated(
        list: List<Note>, id: String, text: String, type: String,
        screenshot: String?, nowMs: Long,
    ): List<Note> = list.map {
        if (it.id == id) it.copy(text = text, type = type, screenshot = screenshot, updatedAtMs = nowMs)
        else it
    }

    fun withStatus(list: List<Note>, id: String, status: String): List<Note> =
        list.map { if (it.id == id) it.copy(status = status) else it }

    fun withDeleted(list: List<Note>, id: String): List<Note> =
        list.filterNot { it.id == id }

    fun encode(list: List<Note>): String =
        json.encodeToString(ListSerializer(Note.serializer()), list)

    fun decode(text: String): List<Note> =
        json.decodeFromString(ListSerializer(Note.serializer()), text)

    fun parseInbox(text: String): List<StatusCommand> =
        text.lineSequence().mapNotNull { line ->
            val t = line.trim()
            if (t.isEmpty()) null
            else try { json.decodeFromString(StatusCommand.serializer(), t) } catch (e: Exception) { null }
        }.toList()

    fun applyInbox(notes: List<Note>, commands: List<StatusCommand>): List<Note> =
        commands.fold(notes) { acc, cmd ->
            acc.map { n ->
                if (n.id == cmd.id) n.copy(
                    status = cmd.status,
                    resolvedCommit = cmd.resolvedCommit ?: n.resolvedCommit,
                    resolvedAt = cmd.resolvedAt ?: n.resolvedAt,
                    resolutionNote = cmd.resolutionNote ?: n.resolutionNote,
                ) else n
            }
        }

    // ---- Context-bound shell (verified on-device) ----

    fun dir(context: Context): File =
        File(context.getExternalFilesDir(null), DIR_NAME).apply { if (!exists()) mkdirs() }

    private fun file(context: Context): File = File(dir(context), FILE_NAME)

    fun screenshotFile(context: Context, id: String): File = File(dir(context), "$id.png")

    fun all(context: Context): List<Note> {
        val f = file(context)
        if (!f.exists()) return emptyList()
        return try {
            decode(f.readText())
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read notes", e); emptyList()
        }
    }

    private fun persist(context: Context, list: List<Note>) {
        try {
            AtomicWrite.write(file(context), encode(list))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write notes", e)
        }
    }

    @Synchronized
    fun addNote(context: Context, note: Note) = persist(context, withAdded(all(context), note))

    @Synchronized
    fun updateNote(
        context: Context, id: String, text: String, type: String, screenshot: String?, nowMs: Long,
    ) = persist(context, withUpdated(all(context), id, text, type, screenshot, nowMs))

    @Synchronized
    fun setStatus(context: Context, id: String, status: String) =
        persist(context, withStatus(all(context), id, status))

    @Synchronized
    fun deleteNote(context: Context, id: String) {
        screenshotFile(context, id).delete()
        persist(context, withDeleted(all(context), id))
    }

    /**
     * Apply queued CC status commands into notes.json. Rename-claims the inbox so a
     * concurrent appender loses nothing; re-applying is idempotent. @Synchronized with
     * the other mutators (shared singleton monitor), so the read-modify-write is atomic
     * against them — safe to call from the launch (background) drain and the Notes-tab
     * (main-thread) drain alike. Returns whether any commands were drained.
     */
    @Synchronized
    fun drainStatusInbox(context: Context): Boolean {
        val inbox = File(dir(context), INBOX_NAME)
        val processing = File(dir(context), PROCESSING_NAME)
        if (inbox.exists()) inbox.renameTo(processing)
        if (!processing.exists()) return false
        val commands = try { parseInbox(processing.readText()) } catch (e: Exception) { emptyList() }
        if (commands.isNotEmpty()) persist(context, applyInbox(all(context), commands))
        processing.delete()
        return commands.isNotEmpty()
    }
}
