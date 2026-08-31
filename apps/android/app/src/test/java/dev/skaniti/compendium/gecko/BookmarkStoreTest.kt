package dev.skaniti.compendium.gecko

import org.junit.Assert.assertTrue
import org.junit.Test

class BookmarkStoreTest {

    @Test
    fun netscapeExportEscapesAndStructures() {
        val html = BookmarkStore.exportNetscapeHtml(
            listOf(
                BookmarkStore.Bookmark("https://a.example/?q=1&r=2", "A & B <tag>", 1781000000000),
                BookmarkStore.Bookmark("https://b.example/", "Plain", 1781000001000),
            )
        )
        assertTrue(html.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>"))
        assertTrue(html.contains("HREF=\"https://a.example/?q=1&amp;r=2\""))
        assertTrue(html.contains("A &amp; B &lt;tag&gt;"))
        assertTrue(html.contains("ADD_DATE=\"1781000000\""))
        assertTrue(html.contains("ADD_DATE=\"1781000001\""))
    }
}
