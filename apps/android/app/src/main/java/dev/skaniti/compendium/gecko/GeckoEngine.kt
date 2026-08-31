package dev.skaniti.compendium.gecko

import android.content.Context
import android.util.Log
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.WebExtension
import org.mozilla.geckoview.WebExtensionController

/**
 * Process-wide GeckoRuntime owner. Creating a second runtime in one process
 * crashes, so everything goes through [runtime].
 *
 * Responsibilities: runtime creation, the extension install-prompt delegate
 * (installs hang without one — spike-verdict.md §API drift 3), and keeping
 * uBlock Origin present (privacy-defaults bundle, user-approved).
 */
object GeckoEngine {

    private const val TAG = "GeckoEngine"
    private const val UBO_ID = "uBlock0@raymondhill.net"
    private const val UBO_XPI =
        "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi"

    @Volatile
    private var runtimeInstance: GeckoRuntime? = null

    fun runtime(context: Context): GeckoRuntime =
        runtimeInstance ?: synchronized(this) {
            runtimeInstance
                ?: create(context.applicationContext).also { runtimeInstance = it }
        }

    private fun create(appContext: Context): GeckoRuntime {
        val rt = GeckoRuntime.create(appContext)

        // W3 comfort settings: pages follow system dark mode; text scale from
        // settings (percent, default 100; applies at next launch).
        rt.settings.preferredColorScheme =
            org.mozilla.geckoview.GeckoRuntimeSettings.COLOR_SCHEME_SYSTEM
        val prefs = appContext.getSharedPreferences("compendium_config", Context.MODE_PRIVATE)
        val scalePct = prefs.getInt("font_scale", 100).coerceIn(50, 200)
        rt.settings.fontSizeFactor = scalePct / 100f

        rt.webExtensionController.promptDelegate =
            object : WebExtensionController.PromptDelegate {
                override fun onInstallPromptRequest(
                    extension: WebExtension,
                    permissions: Array<String>,
                    origins: Array<String>,
                    dataCollectionPermissions: Array<String>,
                ): GeckoResult<WebExtension.PermissionPromptResponse>? =
                    GeckoResult.fromValue(
                        WebExtension.PermissionPromptResponse(true, true, true)
                    )
            }
        ensureUbo(rt)
        return rt
    }

    /** Install uBlock Origin once; no-op when already present. */
    private fun ensureUbo(rt: GeckoRuntime) {
        rt.webExtensionController.list().accept(
            { list ->
                val installed = list?.any { it.id == UBO_ID } == true
                if (!installed) {
                    Log.i(TAG, "Installing uBlock Origin")
                    rt.webExtensionController.install(UBO_XPI).accept(
                        { ext -> Log.i(TAG, "uBO installed: ${ext?.id}") },
                        { err -> Log.w(TAG, "uBO install failed: ${err?.message}") },
                    )
                }
            },
            { err -> Log.w(TAG, "Extension list failed: ${err?.message}") },
        )
    }
}
