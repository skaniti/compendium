package dev.skaniti.compendium

import dev.skaniti.compendium.model.ExportLogEntry
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.YearMonth
import java.time.ZoneId
import java.util.Locale

/** The hub's Laptop tab groups the export log by calendar month (dev-note 1790469504156). */
class ExportMonthsTest {

    private val newYork = ZoneId.of("America/New_York")

    private fun entry(id: String, at: String, pages: Int = 1) = ExportLogEntry(id, pages, at)

    @Test
    fun groupsNewestMonthFirstWithNewestEntryFirst() {
        val months = groupExportsByMonth(
            listOf(
                entry("a", "2026-09-03T12:00:00.000Z", pages = 2),
                entry("b", "2026-10-11T18:39:02.323Z", pages = 5),
                entry("c", "2026-09-28T09:00:00.000Z", pages = 3),
                entry("d", "2026-10-01T15:00:00.000Z"),
            ),
            newYork, Locale.US,
        )
        assertEquals(listOf(YearMonth.of(2026, 10), YearMonth.of(2026, 9)), months.map { it.month })
        assertEquals(listOf("b", "d"), months[0].entries.map { it.sessionId })
        assertEquals(listOf("c", "a"), months[1].entries.map { it.sessionId })
        assertEquals(6, months[0].pageCount)
        assertEquals("October 2026", months[0].label)
    }

    @Test
    fun monthFollowsTheLocalZoneNotUtc() {
        // 02:00 UTC on Oct 1 is still Sep 30 in New York.
        val months = groupExportsByMonth(listOf(entry("a", "2026-10-01T02:00:00.000Z")), newYork, Locale.US)
        assertEquals(YearMonth.of(2026, 9), months.single().month)
    }

    @Test
    fun unparseableTimestampsGoLastUnderUnknownDate() {
        val months = groupExportsByMonth(
            listOf(entry("bad", "not a date"), entry("ok", "2026-10-11T18:39:02.323Z")),
            newYork, Locale.US,
        )
        assertEquals(listOf("October 2026", "Unknown date"), months.map { it.label })
        assertEquals(null, months.last().month)
    }
}
