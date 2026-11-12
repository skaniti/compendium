package dev.skaniti.compendium

import android.content.Context

/** "versionName (versionCode)" of the installed app, e.g. "2.10 (14)"; empty if unreadable. */
fun appVersion(context: Context): String = try {
    val pm = context.packageManager.getPackageInfo(context.packageName, 0)
    @Suppress("DEPRECATION")
    "${pm.versionName} (${pm.versionCode})"
} catch (_: Exception) { "" }
