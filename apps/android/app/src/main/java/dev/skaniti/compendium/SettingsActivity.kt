package dev.skaniti.compendium

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Settings screen (replaces the ee5283b dialog): backend URL, API key,
 * device label (provenance seam, now user-visible), search engine.
 * Stored in the same compendium_config prefs the exporter reads.
 */
class SettingsActivity : AppCompatActivity() {

    companion object {
        private const val PREFS_NAME = "compendium_config"
        private const val KEY_SEARCH = "search_engine"

        private const val DEFAULT_ENGINE = "brave"

        // Order here = display order; Brave first since it's the default.
        private val SEARCH_ENGINES = linkedMapOf(
            "brave" to "https://search.brave.com/search?q=",
            "ddg" to "https://duckduckgo.com/?q=",
            "google" to "https://www.google.com/search?q=",
        )

        /** Brave default (user choice 2026-06-11); overridable in settings. */
        fun searchUrlFor(context: Context, query: String): String {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val engine = prefs.getString(KEY_SEARCH, DEFAULT_ENGINE) ?: DEFAULT_ENGINE
            val base = SEARCH_ENGINES[engine] ?: SEARCH_ENGINES.getValue(DEFAULT_ENGINE)
            return base + Uri.encode(query)
        }
    }

    private lateinit var urlField: EditText
    private lateinit var keyField: EditText
    private lateinit var labelField: EditText
    private lateinit var engineGroup: RadioGroup
    private lateinit var fontSeek: android.widget.SeekBar
    private lateinit var fontLabel: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Settings"

        fun caption(text: String) = TextView(this).apply {
            this.text = text
            setPadding(0, 24, 0, 4)
        }

        urlField = EditText(this).apply {
            hint = "Backend URL (e.g. http://localhost:8001)"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(SessionExporter.getBackendUrl(this@SettingsActivity))
        }
        keyField = EditText(this).apply {
            hint = "API key (cmp_...)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(SessionExporter.getApiKey(this@SettingsActivity))
        }
        labelField = EditText(this).apply {
            hint = "Device label (optional, e.g. flip-phone)"
            inputType = InputType.TYPE_CLASS_TEXT
            setText(SessionExporter.getDeviceLabel(this@SettingsActivity))
        }

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)

        fontSeek = android.widget.SeekBar(this).apply {
            max = 150  // maps to 50..200%
            progress = prefs.getInt("font_scale", 100) - 50
        }
        fontLabel = TextView(this)
        fun renderFontLabel() {
            fontLabel.text = "Text size: ${fontSeek.progress + 50}% (applies on next launch)"
        }
        renderFontLabel()
        fontSeek.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: android.widget.SeekBar?, p: Int, u: Boolean) = renderFontLabel()
            override fun onStartTrackingTouch(s: android.widget.SeekBar?) {}
            override fun onStopTrackingTouch(s: android.widget.SeekBar?) {}
        })

        engineGroup = RadioGroup(this)
        val current = prefs.getString(KEY_SEARCH, DEFAULT_ENGINE)
        for ((id, _) in SEARCH_ENGINES) {
            engineGroup.addView(RadioButton(this).apply {
                // Unique view id is REQUIRED for RadioGroup mutual-exclusion;
                // without it, tapping never unchecks the prior selection and
                // the choice can't be saved.
                this.id = View.generateViewId()
                text = when (id) {
                    "brave" -> "Brave Search (default)"
                    "ddg" -> "DuckDuckGo"
                    else -> "Google"
                }
                tag = id
                isChecked = id == current
            })
        }

        val saveBtn = Button(this).apply {
            text = "Save"
            setOnClickListener { save() }
        }
        val cancelBtn = Button(this).apply {
            text = "Cancel"
            setOnClickListener { finish() }
        }
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(cancelBtn)
            addView(saveBtn)
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 32, 48, 32)
            addView(caption("Backend"))
            addView(urlField)
            addView(keyField)
            addView(caption("Provenance"))
            addView(labelField)
            addView(caption("Search engine"))
            addView(engineGroup)
            addView(fontLabel)
            addView(fontSeek)
            addView(buttons)
        }
        setContentView(ScrollView(this).apply { addView(column) })
    }

    private fun save() {
        SessionExporter.setBackendUrl(this, urlField.text.toString().trim())
        SessionExporter.setApiKey(this, keyField.text.toString().trim())
        SessionExporter.setDeviceLabel(this, labelField.text.toString().trim())

        val checked = (0 until engineGroup.childCount)
            .map { engineGroup.getChildAt(it) as RadioButton }
            .firstOrNull { it.isChecked }
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putString(KEY_SEARCH, (checked?.tag as? String) ?: DEFAULT_ENGINE)
            .putInt("font_scale", fontSeek.progress + 50)
            .apply()

        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        finish()
    }
}
