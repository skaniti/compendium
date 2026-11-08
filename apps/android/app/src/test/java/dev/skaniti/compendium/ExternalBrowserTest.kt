package dev.skaniti.compendium

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalBrowserTest {
    @Test
    fun webPagesAreHandedOff() {
        assertTrue(ExternalBrowser.isWebUrl("https://example.com/"))
        assertTrue(ExternalBrowser.isWebUrl("http://example.com:8080/path"))
        assertTrue(ExternalBrowser.isWebUrl("  HTTPS://Example.com  "))
    }

    @Test
    fun nonWebUrlsAreNot() {
        assertFalse(ExternalBrowser.isWebUrl(null))
        assertFalse(ExternalBrowser.isWebUrl(""))
        assertFalse(ExternalBrowser.isWebUrl("about:blank"))
        assertFalse(ExternalBrowser.isWebUrl("data:text/html,hi"))
        assertFalse(ExternalBrowser.isWebUrl("intent://example.com#Intent;end"))
    }
}
