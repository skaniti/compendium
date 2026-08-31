package dev.skaniti.compendium

import android.app.Activity
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.PixelCopy
import java.io.File
import java.io.FileOutputStream

/** Captures the activity window (page + chrome) to a PNG via PixelCopy (API 24+). */
object ScreenshotCapture {

    private const val TAG = "ScreenshotCapture"

    fun captureWindow(activity: Activity, outFile: File, onDone: (Boolean) -> Unit) {
        val window = activity.window
        val view = window.decorView
        val w = view.width
        val h = view.height
        if (w <= 0 || h <= 0) { onDone(false); return }
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        PixelCopy.request(window, bitmap, { result ->
            val ok = result == PixelCopy.SUCCESS && writePng(bitmap, outFile)
            if (!ok) Log.w(TAG, "PixelCopy failed: $result")
            onDone(ok)
        }, Handler(Looper.getMainLooper()))
    }

    private fun writePng(bitmap: Bitmap, outFile: File): Boolean = try {
        outFile.parentFile?.mkdirs()
        FileOutputStream(outFile).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        true
    } catch (e: Exception) {
        Log.e(TAG, "Failed to write screenshot", e); false
    }
}
