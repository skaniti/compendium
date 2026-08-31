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

        // Seed the working screenshot: edit -> existing file; new -> autoShot copied to <id>.png
        var hasShot = false
        if (existing?.screenshot != null && shotFile.exists()) {
            hasShot = true
        } else if (autoShot != null && autoShot.exists()) {
            autoShot.copyTo(shotFile, overwrite = true)
            if (autoShot.absolutePath != shotFile.absolutePath) autoShot.delete()
            hasShot = true
        }

        fun renderThumb() {
            if (hasShot && shotFile.exists()) {
                thumb.visibility = ImageView.VISIBLE
                thumb.setImageBitmap(android.graphics.BitmapFactory.decodeFile(shotFile.absolutePath))
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
                if (uri != null && copyUriToFile(activity, uri, shotFile)) {
                    hasShot = true; renderThumb()
                }
            }
        }
        btnRemove.setOnClickListener { shotFile.delete(); hasShot = false; renderThumb() }

        AlertDialog.Builder(activity)
            .setTitle(if (existing == null) "New note" else "Edit note")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                val body = text.text.toString().trim()
                if (body.isEmpty()) { shotFile.delete(); return@setPositiveButton }
                val type = if (toggle.checkedButtonId == R.id.typeImprovement)
                    NotesStore.TYPE_IMPROVEMENT else NotesStore.TYPE_ISSUE
                val shotName = if (hasShot && shotFile.exists()) "$id.png" else null
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
                if (existing == null) shotFile.delete()
            }
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
