package dev.skaniti.compendium

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Hands a page to Chrome, for things GeckoView cannot do itself (installing a
 * web app, Chrome-only features). Falls back to an app chooser when Chrome is
 * not installed.
 */
object ExternalBrowser {
    const val CHROME_PACKAGE = "com.android.chrome"

    /** Only real web pages are handed off; about:, data: and blank tabs are not. */
    fun isWebUrl(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val lower = url.trim().lowercase()
        return lower.startsWith("https://") || lower.startsWith("http://")
    }

    /** Returns false when there is nothing to open. */
    fun openInChrome(context: Context, url: String?): Boolean {
        if (!isWebUrl(url)) return false
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(url!!.trim()))
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(Intent(view).setPackage(CHROME_PACKAGE))
        } catch (e: ActivityNotFoundException) {
            context.startActivity(Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        return true
    }
}
