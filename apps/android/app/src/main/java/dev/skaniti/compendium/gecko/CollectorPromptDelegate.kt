package dev.skaniti.compendium.gecko

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.text.InputType
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession

/**
 * Table-stakes prompts (maturation Wave 2): JS alert/confirm/text dialogs and
 * <input type=file> pickers. The WebView app silently swallowed all of these,
 * which broke pages; now they round-trip.
 *
 * File picking needs an activity-result hop, provided by [FilePickerBridge]
 * (implemented by MainActivity with an ActivityResultLauncher).
 */
class CollectorPromptDelegate(
    private val activity: Activity,
    private val filePicker: FilePickerBridge,
) : GeckoSession.PromptDelegate {

    interface FilePickerBridge {
        /** Launch a system picker; invoke onResult with chosen URIs or null on cancel. */
        fun pickFiles(intent: Intent, onResult: (Array<Uri>?) -> Unit)
    }

    override fun onAlertPrompt(
        session: GeckoSession,
        prompt: GeckoSession.PromptDelegate.AlertPrompt,
    ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
        val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
        AlertDialog.Builder(activity)
            .setTitle(prompt.title ?: "Page says")
            .setMessage(prompt.message ?: "")
            .setPositiveButton(android.R.string.ok) { _, _ -> result.complete(prompt.dismiss()) }
            .setOnCancelListener { result.complete(prompt.dismiss()) }
            .show()
        return result
    }

    override fun onButtonPrompt(
        session: GeckoSession,
        prompt: GeckoSession.PromptDelegate.ButtonPrompt,
    ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
        val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
        AlertDialog.Builder(activity)
            .setTitle(prompt.title ?: "Confirm")
            .setMessage(prompt.message ?: "")
            .setPositiveButton(android.R.string.ok) { _, _ ->
                result.complete(prompt.confirm(GeckoSession.PromptDelegate.ButtonPrompt.Type.POSITIVE))
            }
            .setNegativeButton(android.R.string.cancel) { _, _ ->
                result.complete(prompt.confirm(GeckoSession.PromptDelegate.ButtonPrompt.Type.NEGATIVE))
            }
            .setOnCancelListener { result.complete(prompt.dismiss()) }
            .show()
        return result
    }

    override fun onTextPrompt(
        session: GeckoSession,
        prompt: GeckoSession.PromptDelegate.TextPrompt,
    ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
        val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
        val field = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            setText(prompt.defaultValue ?: "")
        }
        AlertDialog.Builder(activity)
            .setTitle(prompt.title ?: "Input")
            .setMessage(prompt.message ?: "")
            .setView(field)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                result.complete(prompt.confirm(field.text.toString()))
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> result.complete(prompt.dismiss()) }
            .setOnCancelListener { result.complete(prompt.dismiss()) }
            .show()
        return result
    }

    override fun onFilePrompt(
        session: GeckoSession,
        prompt: GeckoSession.PromptDelegate.FilePrompt,
    ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
        val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
        val multiple = prompt.type == GeckoSession.PromptDelegate.FilePrompt.Type.MULTIPLE
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = prompt.mimeTypes?.firstOrNull()?.takeIf { it.isNotEmpty() } ?: "*/*"
            if (!prompt.mimeTypes.isNullOrEmpty()) {
                putExtra(Intent.EXTRA_MIME_TYPES, prompt.mimeTypes)
            }
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }
        filePicker.pickFiles(intent) { uris ->
            result.complete(
                when {
                    uris == null || uris.isEmpty() -> prompt.dismiss()
                    multiple -> prompt.confirm(activity, uris)
                    else -> prompt.confirm(activity, uris.first())
                }
            )
        }
        return result
    }
}
