package dev.skaniti.compendium.gecko

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.LruCache
import java.io.File
import java.util.concurrent.Executors

/**
 * Page previews for the tab switcher: a scaled JPEG per tab in files/thumbs/<id>.jpg.
 * Scaling, encoding, decoding and file work run on one background thread (so a save
 * and a later delete of the same tab stay in order); a small in-memory cache serves
 * the cards on screen.
 */
object TabThumbnails {

    private const val TAG = "TabThumbnails"
    private const val DIR_NAME = "thumbs"
    private const val WIDTH_PX = 480
    private const val JPEG_QUALITY = 75

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val cache = LruCache<Int, Bitmap>(12)

    private fun dir(context: Context) = File(context.filesDir, DIR_NAME).apply { mkdirs() }
    private fun file(context: Context, tabId: Int) = File(dir(context), "$tabId.jpg")

    /** Scale [full] down and store it as [tabId]'s preview; [full] is recycled. */
    fun save(context: Context, tabId: Int, full: Bitmap) {
        val target = file(context, tabId)
        io.execute {
            try {
                val scaled = if (full.width <= WIDTH_PX) full
                else Bitmap.createScaledBitmap(full, WIDTH_PX, full.height * WIDTH_PX / full.width, true)
                if (scaled !== full) full.recycle()
                cache.put(tabId, scaled)
                // Write beside the target and rename, so a kill mid-write never leaves a
                // truncated JPEG behind.
                val tmp = File(target.parentFile, "${target.name}.tmp")
                tmp.outputStream().use { scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
                if (!tmp.renameTo(target)) tmp.delete()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to save preview for tab $tabId", e)
            }
        }
    }

    /** Deliver the tab's preview (null when none was captured yet) on the main thread. */
    fun load(context: Context, tabId: Int, onLoaded: (Bitmap?) -> Unit) {
        cache.get(tabId)?.let { onLoaded(it); return }
        val f = file(context, tabId)
        io.execute {
            val bitmap = cache.get(tabId)
                ?: if (f.exists()) BitmapFactory.decodeFile(f.path)?.also { cache.put(tabId, it) } else null
            main.post { onLoaded(bitmap) }
        }
    }

    fun delete(context: Context, tabId: Int) {
        val target = file(context, tabId)
        io.execute {
            cache.remove(tabId)
            target.delete()
        }
    }

    /** Remove previews, on disk and in memory, of tabs that no longer exist. */
    fun prune(context: Context, liveIds: Set<Int>) {
        val d = dir(context)
        io.execute {
            cache.snapshot().keys.filter { it !in liveIds }.forEach { cache.remove(it) }
            d.listFiles()?.forEach { f ->
                val id = f.name.substringBefore('.').toIntOrNull()
                if (id == null || id !in liveIds) f.delete()
            }
        }
    }
}
