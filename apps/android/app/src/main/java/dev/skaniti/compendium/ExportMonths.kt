package dev.skaniti.compendium

import dev.skaniti.compendium.model.ExportLogEntry
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/** One calendar month of the export log; [month] is null for entries whose timestamp would not parse. */
internal data class ExportMonth(
    val month: YearMonth?,
    val label: String,
    val entries: List<ExportLogEntry>,
) {
    val pageCount: Int get() = entries.sumOf { it.pageCount }
}

/**
 * Group the export log by the local calendar month of each export, newest month
 * first and newest export first within a month. Unparseable timestamps go last.
 */
internal fun groupExportsByMonth(entries: List<ExportLogEntry>, zone: ZoneId, locale: Locale): List<ExportMonth> {
    val stamped = entries.map { e -> e to runCatching { Instant.parse(e.exportedAt) }.getOrNull() }
    val dated = stamped.filter { it.second != null }
        .sortedByDescending { it.second }
        .groupBy { YearMonth.from(it.second!!.atZone(zone)) }
        .map { (month, rows) ->
            val name = month.month.getDisplayName(TextStyle.FULL_STANDALONE, locale)
            ExportMonth(month, "$name ${month.year}", rows.map { it.first })
        }
        .sortedByDescending { it.month }
    // The log is appended in order, so reversing puts the newest undated export first.
    val undated = stamped.filter { it.second == null }.map { it.first }.asReversed()
    return if (undated.isEmpty()) dated else dated + ExportMonth(null, "Unknown date", undated)
}
