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

    /**
     * Cleanup for a note dialog that closes without saving a note (Cancel button,
     * Back / outside-tap cancel, or Save with an empty body). Only a NEW note owns
     * its working screenshot (the auto-captured copy at `<id>.png`); an existing
     * note's screenshot is its saved attachment and must survive. Idempotent.
     */
    fun discardWorkingShot(existing: Note?, shotFile: File) {
        if (existing == null) shotFile.delete()
    }

    /**
     * A screenshot change made in the note dialog but not yet saved. Remove and
     * Replace only record intent (Replace holds a staged copy); the saved file is
     * touched on Save via [commitPendingShot] and left alone on dismiss via
     * [discardPendingShot].
     */
    sealed interface PendingShot {
        data object None : PendingShot
        data object Remove : PendingShot
        data class Replace(val staged: File) : PendingShot
    }

    /** Sibling staging file for a replacement of [shotFile] (`<id>.png` -> `<id>.pending.png`). */
    fun stagingFile(shotFile: File): File =
        File(shotFile.parentFile, shotFile.nameWithoutExtension + ".pending." + shotFile.extension)

    /** Apply [pending] to the saved [shotFile]; call on Save. Consumes a staged file. */
    fun commitPendingShot(shotFile: File, pending: PendingShot) {
        when (pending) {
            PendingShot.None -> Unit
            PendingShot.Remove -> shotFile.delete()
            is PendingShot.Replace -> {
                // rename is atomic within the directory; copy only if it is refused
                if (!pending.staged.renameTo(shotFile)) {
                    pending.staged.copyTo(shotFile, overwrite = true)
                    pending.staged.delete()
                }
            }
        }
    }

    /** Delete any stray staging file for [shotFile] (dialog torn down without cancel, deleted note). */
    fun clearStaging(shotFile: File) { stagingFile(shotFile).delete() }

    /**
     * Commit [pending] and return the attachment name to store: derived from dialog
     * state ([hadShot] + [pending]), never from what happens to be on disk. If a
     * Replace fails with an I/O error the old shot is kept and its name returned.
     */
    fun commitAndName(id: String, hadShot: Boolean, shotFile: File, pending: PendingShot): String? {
        val old = if (hadShot) "$id.png" else null
        return try {
            commitPendingShot(shotFile, pending)
            when (pending) {
                PendingShot.None -> old
                PendingShot.Remove -> null
                is PendingShot.Replace -> "$id.png"
            }
        } catch (e: java.io.IOException) {
            discardPendingShot(pending)
            old
        }
    }

    /** Drop a staged replacement without touching the saved file; call on any dismiss. Idempotent. */
    fun discardPendingShot(pending: PendingShot) {
        if (pending is PendingShot.Replace) pending.staged.delete()
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
        screenshotFile(context, id).let { it.delete(); clearStaging(it) }
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
