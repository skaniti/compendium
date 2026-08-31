package dev.skaniti.compendium.gecko

import dev.skaniti.compendium.gecko.NotesStore.Note
import dev.skaniti.compendium.gecko.NotesStore.StatusCommand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StatusInboxTest {

    private fun note(id: String, status: String = "open") =
        Note(id = id, createdAtMs = 1L, text = "t", type = "issue", status = status)

    @Test
    fun applyMarksDoneWithAllFields() {
        val out = NotesStore.applyInbox(
            listOf(note("a")),
            listOf(StatusCommand("a", "done", "abc123", 5000L, "fixed it")),
        ).single()
        assertEquals("done", out.status)
        assertEquals("abc123", out.resolvedCommit)
        assertEquals(5000L, out.resolvedAt)
        assertEquals("fixed it", out.resolutionNote)
    }

    @Test
    fun reopenPreservesResolution() {
        val done = note("a", "done")
            .copy(resolvedCommit = "abc123", resolvedAt = 5000L, resolutionNote = "fixed it")
        val out = NotesStore.applyInbox(listOf(done), listOf(StatusCommand("a", "open"))).single()
        assertEquals("open", out.status)
        assertEquals("abc123", out.resolvedCommit)   // preserved
        assertEquals(5000L, out.resolvedAt)
        assertEquals("fixed it", out.resolutionNote)
    }

    @Test
    fun unknownIdIsNoOp() {
        val notes = listOf(note("a"))
        assertEquals(notes, NotesStore.applyInbox(notes, listOf(StatusCommand("zzz", "done"))))
    }

    @Test
    fun lastCommandWinsForSameId() {
        val out = NotesStore.applyInbox(
            listOf(note("a")),
            listOf(StatusCommand("a", "done", "c1", 9L, "x"), StatusCommand("a", "open")),
        ).single()
        assertEquals("open", out.status)
        assertEquals("c1", out.resolvedCommit)   // preserved through reopen
    }

    @Test
    fun parseSkipsBlankAndMalformedLines() {
        val text = "{\"id\":\"a\",\"status\":\"done\",\"resolvedCommit\":\"c1\"}\n\nnot json\n{\"id\":\"b\",\"status\":\"open\"}"
        val cmds = NotesStore.parseInbox(text)
        assertEquals(listOf("a", "b"), cmds.map { it.id })
        assertEquals("c1", cmds.first().resolvedCommit)
    }

    @Test
    fun statusCommandToleratesMissingOptionals() {
        val cmds = NotesStore.parseInbox("{\"id\":\"a\",\"status\":\"done\"}")
        assertNull(cmds.single().resolvedCommit)
        assertNull(cmds.single().resolvedAt)
    }
}
