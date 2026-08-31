package dev.skaniti.compendium.gecko

import org.junit.Assert.assertEquals
import org.junit.Test
import org.mozilla.geckoview.GeckoSession.PermissionDelegate
import org.mozilla.geckoview.GeckoSession.PermissionDelegate.ContentPermission

/**
 * Regression guard for the "Allow this site to use a device feature?" dialog
 * that fired on nearly every page (autoplay, tracking, ...). Non-user-decidable
 * content permissions must auto-resolve and never prompt; only the four
 * user-decidable permissions return [ContentPermissionDecision.Ask].
 */
class CollectorPermissionDecisionTest {

    @Test
    fun inaudibleAutoplayAutoAllowed() {
        assertEquals(
            ContentPermissionDecision.Auto(ContentPermission.VALUE_ALLOW),
            decideContentPermission(PermissionDelegate.PERMISSION_AUTOPLAY_INAUDIBLE),
        )
    }

    @Test
    fun audibleAutoplayAutoDenied() {
        assertEquals(
            ContentPermissionDecision.Auto(ContentPermission.VALUE_DENY),
            decideContentPermission(PermissionDelegate.PERMISSION_AUTOPLAY_AUDIBLE),
        )
    }

    @Test
    fun trackingAutoDeniedNotPrompted() {
        assertEquals(
            ContentPermissionDecision.Auto(ContentPermission.VALUE_DENY),
            decideContentPermission(PermissionDelegate.PERMISSION_TRACKING),
        )
    }

    @Test
    fun storageAccessAutoDeniedNotPrompted() {
        assertEquals(
            ContentPermissionDecision.Auto(ContentPermission.VALUE_DENY),
            decideContentPermission(PermissionDelegate.PERMISSION_STORAGE_ACCESS),
        )
    }

    @Test
    fun unknownPermissionAutoDenied() {
        assertEquals(
            ContentPermissionDecision.Auto(ContentPermission.VALUE_DENY),
            decideContentPermission(Int.MAX_VALUE),
        )
    }

    @Test
    fun geolocationStillPrompts() {
        assertEquals(
            ContentPermissionDecision.Ask("use your location"),
            decideContentPermission(PermissionDelegate.PERMISSION_GEOLOCATION),
        )
    }

    @Test
    fun notificationsStillPrompt() {
        assertEquals(
            ContentPermissionDecision.Ask("show notifications"),
            decideContentPermission(PermissionDelegate.PERMISSION_DESKTOP_NOTIFICATION),
        )
    }

    @Test
    fun drmStillPrompts() {
        assertEquals(
            ContentPermissionDecision.Ask("play DRM media"),
            decideContentPermission(PermissionDelegate.PERMISSION_MEDIA_KEY_SYSTEM_ACCESS),
        )
    }
}
