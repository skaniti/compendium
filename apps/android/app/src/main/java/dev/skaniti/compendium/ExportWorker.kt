package dev.skaniti.compendium

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Periodic background export of pending sessions. This is the structural fix
 * for the 2026-04-22→06-10 stranding: delivery no longer depends on the app
 * being opened — WorkManager persists the schedule across reboots and runs
 * whenever the network constraint is met.
 *
 * Delete-only-on-2xx/409 lives in SessionExporter.exportPendingFilesBlocking;
 * this class only decides retry-vs-done.
 */
class ExportWorker(appContext: Context, params: WorkerParameters) :
    Worker(appContext, params) {

    override fun doWork(): Result {
        val ctx = applicationContext
        val pending = SessionExporter.getSessionCount(ctx)
        if (pending == 0) return Result.success()

        if (SessionExporter.pingBackend(ctx) != null) {
            Log.i(TAG, "Backend unreachable with $pending pending; will retry")
            return Result.retry()
        }

        val result = SessionExporter.exportPendingFilesBlocking(ctx)
        Log.i(TAG, "Periodic export: ${result.exported} exported, ${result.failed} failed")
        return if (result.failed > 0 && result.exported == 0) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "ExportWorker"
        private const val WORK_NAME = "export-pending"

        /** Idempotent: KEEP preserves the existing schedule across launches. */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ExportWorker>(6, TimeUnit.HOURS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request
            )
        }
    }
}
