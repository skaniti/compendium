package dev.skaniti.compendium.gecko

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import org.mozilla.geckoview.WebResponse
import kotlin.concurrent.thread

/**
 * Saves a non-renderable response (ContentDelegate.onExternalResponse) into
 * the system Downloads collection via MediaStore — no storage permission
 * needed on API 29+, and unlike DownloadManager the bytes come from Gecko's
 * already-authenticated response stream instead of a cookie-less re-fetch.
 */
object DownloadHelper {

    private const val TAG = "DownloadHelper"

    /** [onDone] runs on the main thread once the download has finished or failed. */
    fun save(context: Context, response: WebResponse, onDone: () -> Unit = {}) {
        val body = response.body
        if (body == null) {
            Log.w(TAG, "External response with no body: ${response.uri}")
            onDone()
            return
        }
        val main = android.os.Handler(context.mainLooper)

        val fileName = fileNameFor(response)
        val mime = response.headers["Content-Type"]?.substringBefore(';')?.trim()
            ?: "application/octet-stream"

        thread {
            try {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val resolver = context.contentResolver
                val target: Uri? =
                    resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                if (target == null) {
                    Log.e(TAG, "MediaStore insert failed for $fileName")
                    main.post(onDone)
                    return@thread
                }
                resolver.openOutputStream(target).use { out ->
                    body.use { input -> input.copyTo(out!!) }
                }
                Log.i(TAG, "Downloaded $fileName ($mime)")
                main.post {
                    Toast.makeText(context, "Downloaded $fileName", Toast.LENGTH_SHORT).show()
                    onDone()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Download failed: ${response.uri}", e)
                main.post {
                    Toast.makeText(context, "Download failed", Toast.LENGTH_SHORT).show()
                    onDone()
                }
            }
        }
    }

    private fun fileNameFor(response: WebResponse): String {
        val disposition = response.headers["Content-Disposition"]
        val fromHeader = disposition
            ?.let { Regex("filename=\"?([^\";]+)\"?").find(it)?.groupValues?.get(1) }
        val fromUri = Uri.parse(response.uri).lastPathSegment
        return (fromHeader ?: fromUri ?: "download").take(120)
    }
}
