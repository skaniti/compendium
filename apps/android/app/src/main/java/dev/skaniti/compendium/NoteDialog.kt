package dev.skaniti.compendium

import android.app.Activity
import android.net.Uri
import android.os.Build
import android.view.LayoutInflater
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.google.android.material.button.MaterialButtonToggleGroup
import dev.skaniti.compendium.gecko.NotesStore
import dev.skaniti.compendium.gecko.NotesStore.Note
import java.io.File

interface ImagePicker {
    /** Launches the system image picker; [onPicked] receives the content Uri or null. */
    fun pickImage(onPicked: (Uri?) -> Unit)
}

object NoteDialog {

    /**
     * Show the create/edit note dialog.
     * @param existing non-null = edit mode (pre-filled, updates in place).
     * @param autoShot a PNG already captured for a NEW note (browser path), else null.
     */
    fun show(
        activity: Activity,
        picker: ImagePicker,
        existing: Note?,
        autoShot: File?,
        activeUrl: String?,
        activeTitle: String?,
        onSaved: () -> Unit,
    ) {
        val view = LayoutInflater.from(activity).inflate(R.layout.dialog_note, null)
        val toggle = view.findViewById<MaterialButtonToggleGroup>(R.id.typeToggle)
        val text = view.findViewById<EditText>(R.id.noteText)
        val contextLine = view.findViewById<TextView>(R.id.contextLine)
        val thumb = view.findViewById<ImageView>(R.id.screenshotThumb)
        val btnReplace = view.findViewById<Button>(R.id.btnReplaceShot)
        val btnRemove = view.findViewById<Button>(R.id.btnRemoveShot)

        val id = existing?.id ?: "note-${System.currentTimeMillis()}"
        val shotFile = NotesStore.screenshotFile(activity, id)
        // A rotation or process death can leave a staged file behind (no cancel callback).
        NotesStore.sweepStaging(NotesStore.dir(activity))

        // Seed the working screenshot: edit -> existing file; new -> autoShot copied to <id>.png
        var hasShot = false
        if (existing?.screenshot != null && shotFile.exists()) {
            hasShot = true
        } else if (autoShot != null && autoShot.exists()) {
            autoShot.copyTo(shotFile, overwrite = true)
            if (autoShot.absolutePath != shotFile.absolutePath) autoShot.delete()
            hasShot = true
        }

        // Remove/Replace are deferred to Save; the saved file stays untouched until then.
        var pending: NotesStore.PendingShot = NotesStore.PendingShot.None

        fun renderThumb() {
            val shown = when (val p = pending) {
                is NotesStore.PendingShot.Replace -> p.staged
                NotesStore.PendingShot.Remove -> null
                NotesStore.PendingShot.None -> if (hasShot && shotFile.exists()) shotFile else null
            }
            if (shown != null) {
                thumb.visibility = ImageView.VISIBLE
                thumb.setImageBitmap(android.graphics.BitmapFactory.decodeFile(shown.absolutePath))
                btnRemove.visibility = Button.VISIBLE
            } else {
                thumb.visibility = ImageView.GONE
                btnRemove.visibility = Button.GONE
            }
        }

        // Pre-fill
        text.setText(existing?.text ?: "")
        toggle.check(if (existing?.type == NotesStore.TYPE_IMPROVEMENT) R.id.typeImprovement else R.id.typeIssue)
        val url = existing?.url ?: activeUrl
        val title = existing?.pageTitle ?: activeTitle
        contextLine.text = listOfNotNull(title?.ifBlank { null }, url?.ifBlank { null }).joinToString("\n")
        renderThumb()

        btnReplace.setOnClickListener {
            picker.pickImage { uri ->
                val staged = NotesStore.stagingFile(shotFile)
                if (uri != null) {
                    // Copy to a fresh temp first so a failed pick cannot truncate an earlier staged file.
                    val tmpFile = File(staged.parentFile, staged.name + ".tmp")
                    if (copyUriToFile(activity, uri, tmpFile) && tmpFile.renameTo(staged)) {
                        pending = NotesStore.PendingShot.Replace(staged); renderThumb()
                    } else {
                        tmpFile.delete()
                    }
                }
            }
        }
        btnRemove.setOnClickListener {
            NotesStore.discardPendingShot(pending)
            pending = NotesStore.PendingShot.Remove; renderThumb()
        }

        fun discardAll() {
            NotesStore.discardPendingShot(pending)
            NotesStore.discardWorkingShot(existing, shotFile)
        }

        AlertDialog.Builder(activity)
            .setTitle(if (existing == null) "New note" else "Edit note")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                val body = text.text.toString().trim()
                if (body.isEmpty()) { discardAll(); return@setPositiveButton }
                val type = if (toggle.checkedButtonId == R.id.typeImprovement)
                    NotesStore.TYPE_IMPROVEMENT else NotesStore.TYPE_ISSUE
                val shotName = NotesStore.commitAndName(id, hasShot, shotFile, pending) { e ->
                    android.util.Log.w("NoteDialog", "Screenshot commit failed", e)
                    android.widget.Toast.makeText(activity, "Screenshot not saved; kept previous", android.widget.Toast.LENGTH_LONG).show()
                }
                val now = System.currentTimeMillis()
                if (existing == null) {
                    NotesStore.addNote(
                        activity,
                        Note(
                            id = id, createdAtMs = now, text = body, type = type,
                            url = url, pageTitle = title,
                            appVersion = appVersion(activity), device = Build.MODEL,
                            androidApi = Build.VERSION.SDK_INT, screenshot = shotName,
                        ),
                    )
                } else {
                    NotesStore.updateNote(activity, id, body, type, shotName, now)
                }
                onSaved()
            }
            .setNegativeButton("Cancel") { _, _ ->
                // discard a freshly-copied auto-shot for a never-saved new note
                discardAll()
            }
            // Back / tap outside cancels the dialog without calling the Cancel button
            // handler; mirror it so the auto-shot is not orphaned in dev-notes/.
            .setOnCancelListener { discardAll() }
            .show()
    }

    private fun appVersion(activity: Activity): String = try {
        val pm = activity.packageManager.getPackageInfo(activity.packageName, 0)
        @Suppress("DEPRECATION")
        "${pm.versionName} (${pm.versionCode})"
    } catch (_: Exception) { "" }

    private fun copyUriToFile(activity: Activity, uri: Uri, dest: File): Boolean = try {
        activity.contentResolver.openInputStream(uri)?.use { input ->
            dest.outputStream().use { input.copyTo(it) }
        }
        dest.exists() && dest.length() > 0
    } catch (_: Exception) { false }
}
