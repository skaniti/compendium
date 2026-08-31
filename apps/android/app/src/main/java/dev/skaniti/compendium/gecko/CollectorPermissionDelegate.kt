package dev.skaniti.compendium.gecko

import android.app.Activity
import androidx.appcompat.app.AlertDialog
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession

/**
 * Permission round-trips (maturation Wave 2). The WebView app auto-denied
 * everything by omission; pages requesting camera/mic/location just broke.
 *
 * Three layers, per GeckoView's model:
 *  - Android runtime permissions (CAMERA, RECORD_AUDIO, location) via
 *    [RuntimePermissionBridge] (MainActivity's ActivityResultLauncher).
 *  - Content permissions: the user-decidable ones (geolocation, notifications,
 *    persistent storage, DRM) prompt; autoplay and everything else auto-resolve
 *    without a dialog (see [decideContentPermission]).
 *  - Media device permissions (which camera/mic) -> grant first matching
 *    device after the user approves.
 */
class CollectorPermissionDelegate(
    private val activity: Activity,
    private val runtimePerms: RuntimePermissionBridge,
) : GeckoSession.PermissionDelegate {

    interface RuntimePermissionBridge {
        fun request(permissions: Array<String>, onResult: (Boolean) -> Unit)
    }

    override fun onAndroidPermissionsRequest(
        session: GeckoSession,
        permissions: Array<String>?,
        callback: GeckoSession.PermissionDelegate.Callback,
    ) {
        if (permissions.isNullOrEmpty()) {
            callback.grant()
            return
        }
        runtimePerms.request(permissions) { granted ->
            if (granted) callback.grant() else callback.reject()
        }
    }

    override fun onContentPermissionRequest(
        session: GeckoSession,
        perm: GeckoSession.PermissionDelegate.ContentPermission,
    ): GeckoResult<Int>? {
        when (val decision = decideContentPermission(perm.permission)) {
            is ContentPermissionDecision.Auto -> return GeckoResult.fromValue(decision.value)
            is ContentPermissionDecision.Ask -> {
                val result = GeckoResult<Int>()
                AlertDialog.Builder(activity)
                    .setTitle(perm.uri)
                    .setMessage("Allow this site to ${decision.what}?")
                    .setPositiveButton("Allow") { _, _ ->
                        result.complete(GeckoSession.PermissionDelegate.ContentPermission.VALUE_ALLOW)
                    }
                    .setNegativeButton("Block") { _, _ ->
                        result.complete(GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY)
                    }
                    .setOnCancelListener {
                        result.complete(GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY)
                    }
                    .show()
                return result
            }
        }
    }

    override fun onMediaPermissionRequest(
        session: GeckoSession,
        uri: String,
        video: Array<out GeckoSession.PermissionDelegate.MediaSource>?,
        audio: Array<out GeckoSession.PermissionDelegate.MediaSource>?,
        callback: GeckoSession.PermissionDelegate.MediaCallback,
    ) {
        val wants = listOfNotNull(
            if (!video.isNullOrEmpty()) "camera" else null,
            if (!audio.isNullOrEmpty()) "microphone" else null,
        ).joinToString(" and ")
        AlertDialog.Builder(activity)
            .setTitle(uri)
            .setMessage("Allow this site to use your $wants?")
            .setPositiveButton("Allow") { _, _ ->
                callback.grant(video?.firstOrNull(), audio?.firstOrNull())
            }
            .setNegativeButton("Block") { _, _ -> callback.reject() }
            .setOnCancelListener { callback.reject() }
            .show()
    }
}

/** Outcome of a content-permission request. */
internal sealed interface ContentPermissionDecision {
    /** Resolve immediately with a [ContentPermission] VALUE_* and no UI. */
    data class Auto(val value: Int) : ContentPermissionDecision

    /** Prompt the user; [what] fills "Allow this site to <what>?". */
    data class Ask(val what: String) : ContentPermissionDecision
}

/**
 * Decide how to answer a content-permission request, with no Android
 * dependency so it stays unit-testable.
 *
 * Autoplay fires on nearly every page with media, so it must never prompt
 * (the old generic "use a device feature?" dialog): muted (inaudible)
 * autoplay is allowed like any browser; audible autoplay is blocked by
 * default (matching Firefox/Chrome) until the user interacts. Tracking,
 * storage-access, XR, local-network/device, and any future permission are
 * auto-denied rather than surfacing a meaningless prompt. Only the four
 * permissions a user can meaningfully decide are surfaced as a dialog.
 */
internal fun decideContentPermission(permission: Int): ContentPermissionDecision = when (permission) {
    GeckoSession.PermissionDelegate.PERMISSION_AUTOPLAY_INAUDIBLE ->
        ContentPermissionDecision.Auto(GeckoSession.PermissionDelegate.ContentPermission.VALUE_ALLOW)
    GeckoSession.PermissionDelegate.PERMISSION_AUTOPLAY_AUDIBLE ->
        ContentPermissionDecision.Auto(GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY)
    GeckoSession.PermissionDelegate.PERMISSION_GEOLOCATION ->
        ContentPermissionDecision.Ask("use your location")
    GeckoSession.PermissionDelegate.PERMISSION_DESKTOP_NOTIFICATION ->
        ContentPermissionDecision.Ask("show notifications")
    GeckoSession.PermissionDelegate.PERMISSION_PERSISTENT_STORAGE ->
        ContentPermissionDecision.Ask("use persistent storage")
    GeckoSession.PermissionDelegate.PERMISSION_MEDIA_KEY_SYSTEM_ACCESS ->
        ContentPermissionDecision.Ask("play DRM media")
    else ->
        ContentPermissionDecision.Auto(GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY)
}
