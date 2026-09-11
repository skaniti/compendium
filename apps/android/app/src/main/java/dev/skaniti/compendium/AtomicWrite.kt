package dev.skaniti.compendium

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Crash-safe whole-file replacement: write a sibling temp file, fsync it,
 * then rename it over the target. A process kill mid-write leaves the old
 * target intact instead of a truncated file. GeckoView's memory footprint
 * makes background kills routine, and tabs.json is rewritten on every
 * navigation, so the in-place `File.writeText` this replaces was a live
 * data-loss path (dev-note N2, 2026-08-07).
 *
 * On failure the target is never touched: the temp file is removed and the
 * exception propagates so the caller's existing catch can log it.
 */
object AtomicWrite {

    fun write(target: File, text: String) {
        val tmp = File(target.parentFile, target.name + ".tmp")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(text.toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            if (!tmp.renameTo(target)) {
                throw IOException("rename ${tmp.name} -> ${target.name} failed")
            }
        } catch (e: IOException) {
            tmp.delete()
            throw e
        }
    }
}
