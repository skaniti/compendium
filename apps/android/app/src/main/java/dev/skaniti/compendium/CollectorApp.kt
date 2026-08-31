package dev.skaniti.compendium

import android.app.ActivityManager
import android.app.Application
import android.os.Build
import com.google.android.material.color.DynamicColors
import dev.skaniti.compendium.gecko.NotesStore

/**
 * Application entry: process-level wiring that must not depend on any
 * activity being opened (the 2026 stranding lesson — delivery independence).
 *
 * GeckoView is multi-process (:tab_*, :gpu_*, :crashhelper_*, ...), and this
 * class runs in EVERY one of them — but WorkManager's initializer only runs
 * in the main process, so scheduling must be main-process-guarded (child
 * processes crashed on WorkManager.getInstance otherwise).
 */
class CollectorApp : Application() {

    override fun onCreate() {
        super.onCreate()
        // Material You: overlay the wallpaper-derived palette on every
        // activity (Android 12+; no-op below, where the bespoke theme shows).
        DynamicColors.applyToActivitiesIfAvailable(this)
        if (isMainProcess()) {
            // Idempotent (KEEP policy); lives here so the schedule exists
            // even when the process starts for a WorkManager run rather
            // than a user launch.
            ExportWorker.schedule(this)
            val app = this
            kotlin.concurrent.thread { NotesStore.drainStatusInbox(app) }
        }
    }

    private fun isMainProcess(): Boolean {
        val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getProcessName()
        } else {
            val pid = android.os.Process.myPid()
            val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
            am.runningAppProcesses?.firstOrNull { it.pid == pid }?.processName
                ?: packageName
        }
        return name == packageName
    }
}
