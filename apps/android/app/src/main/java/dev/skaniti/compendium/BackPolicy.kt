package dev.skaniti.compendium

/**
 * What the Back key does in MainActivity. Back never finishes the activity:
 * finishing drops the task (and its tabs) from recents, so the last step
 * sends the task to the background instead.
 */
object BackPolicy {
    enum class Action { EXIT_FULLSCREEN, GO_BACK, MOVE_TO_BACKGROUND }

    fun decide(hasTab: Boolean, isFullScreen: Boolean, canGoBack: Boolean): Action = when {
        isFullScreen && hasTab -> Action.EXIT_FULLSCREEN
        hasTab && canGoBack -> Action.GO_BACK
        else -> Action.MOVE_TO_BACKGROUND
    }
}
