package dev.skaniti.compendium.gecko

/**
 * Ports TransitionTracker's Chrome-compatible transition taxonomy to
 * GeckoSession delegate signals (spike-verdict.md §(a)).
 *
 * Signals collected between consume() calls; consume() runs at
 * ProgressDelegate.onPageStop(success=true), mirroring the WebView app's
 * record-on-onPageFinished behavior.
 *
 * Resolution order:
 *   1. UI marker (typed / back_forward / reload / tab_switch) wins; an
 *      observed HTTP redirect adds the server_redirect qualifier.
 *   2. loadRequest seen → "link" (gesture and gestureless API navs alike).
 *   3. visited without loadRequest → "spa_navigation" (history.pushState /
 *      replaceState — fires HistoryDelegate.onVisited but no loadRequest).
 *   4. locationChange alone → "back_forward" (history traversal: the spike
 *      showed back-nav emits locationChange with neither loadRequest nor
 *      visited). Deliberate improvement: the WebView tracker mislabeled
 *      JS history traversal as spa_navigation.
 *   5. Nothing → "link" (legacy default; unreachable in practice since
 *      consume only runs after a page load).
 *
 * Known degradation vs WebView: Gecko's LoadRequest carries no HTTP method,
 * so "form_submit" is not discriminable and lands as "link" (plan Task 10
 * parity notes).
 */
class GeckoTransitionMapper {

    private var marker: String? = null
    private var sawLoadRequest = false
    private var sawGesture = false
    private var sawRedirect = false
    private var sawVisited = false
    private var sawLocationChange = false

    // --- UI markers (called BEFORE triggering navigation) ---

    fun markTyped() { reset(); marker = "typed" }
    fun markBack() { reset(); marker = "back_forward" }
    fun markForward() { reset(); marker = "back_forward" }
    fun markReload() { reset(); marker = "reload" }
    fun markTabSwitch() { reset(); marker = "tab_switch" }

    // --- Delegate signals ---

    fun onLoadRequest(hasGesture: Boolean, isRedirect: Boolean) {
        sawLoadRequest = true
        if (hasGesture) sawGesture = true
        if (isRedirect) sawRedirect = true
    }

    fun onVisited() { sawVisited = true }

    fun onLocationChanged() { sawLocationChange = true }

    /** Finalize at onPageStop(success=true); resets for the next navigation. */
    fun consume(): Pair<String, List<String>> {
        val qualifiers = if (sawRedirect) listOf("server_redirect") else emptyList()
        val type = when {
            marker != null -> marker!!
            sawLoadRequest -> "link"
            sawVisited -> "spa_navigation"
            sawLocationChange -> "back_forward"
            else -> "link"
        }
        reset()
        return type to qualifiers
    }

    private fun reset() {
        marker = null
        sawLoadRequest = false
        sawGesture = false
        sawRedirect = false
        sawVisited = false
        sawLocationChange = false
    }
}
