package dev.skaniti.compendium

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import dev.skaniti.compendium.gecko.BookmarkStore
import java.io.File

/**
 * Bookmarks list (W3): tap opens in a new tab, long-press removes, EXPORT
 * shares Netscape-format HTML (importable by any browser) via the share
 * sheet. Local-only by design; no history UI exists (user decision).
 */
class BookmarksActivity : AppCompatActivity() {

    private lateinit var listView: ListView
    private var items: List<BookmarkStore.Bookmark> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Bookmarks"

        val exportBtn = Button(this).apply {
            text = "Export (HTML)"
            setOnClickListener { exportBookmarks() }
        }
        listView = ListView(this)
        val empty = TextView(this).apply {
            text = "No bookmarks yet — use the menu's \"Add bookmark\"."
            setPadding(32, 32, 32, 32)
        }
        listView.emptyView = empty

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(exportBtn)
            addView(empty)
            addView(listView)
        }
        setContentView(column)

        listView.setOnItemClickListener { _, _, pos, _ ->
            val bm = items.getOrNull(pos) ?: return@setOnItemClickListener
            startActivity(
                Intent(this, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    data = Uri.parse(bm.url)
                }
            )
            finish()
        }
        listView.setOnItemLongClickListener { _, _, pos, _ ->
            val bm = items.getOrNull(pos) ?: return@setOnItemLongClickListener false
            AlertDialog.Builder(this)
                .setMessage("Remove bookmark \"${bm.title}\"?")
                .setPositiveButton("Remove") { _, _ ->
                    BookmarkStore.remove(this, bm.url)
                    refresh()
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
            true
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        items = BookmarkStore.all(this).sortedByDescending { it.addedAtMs }
        listView.adapter = object : ArrayAdapter<BookmarkStore.Bookmark>(
            this, android.R.layout.simple_list_item_2, android.R.id.text1, items
        ) {
            override fun getView(position: Int, convertView: android.view.View?, parent: android.view.ViewGroup): android.view.View {
                val v = super.getView(position, convertView, parent)
                v.findViewById<TextView>(android.R.id.text1).text = items[position].title
                v.findViewById<TextView>(android.R.id.text2).text = items[position].url
                return v
            }
        }
    }

    private fun exportBookmarks() {
        val bookmarks = BookmarkStore.all(this)
        if (bookmarks.isEmpty()) {
            Toast.makeText(this, "Nothing to export", Toast.LENGTH_SHORT).show()
            return
        }
        val html = BookmarkStore.exportNetscapeHtml(bookmarks.sortedBy { it.addedAtMs })
        val out = File(cacheDir, "bookmarks-export.html")
        out.writeText(html)
        val uri = FileProvider.getUriForFile(this, "dev.skaniti.compendium.fileprovider", out)
        startActivity(
            Intent.createChooser(
                Intent(Intent.ACTION_SEND).apply {
                    type = "text/html"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                },
                "Export bookmarks",
            )
        )
    }
}
