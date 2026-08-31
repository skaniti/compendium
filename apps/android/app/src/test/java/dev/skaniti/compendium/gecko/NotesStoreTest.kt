package dev.skaniti.compendium.gecko

import dev.skaniti.compendium.gecko.NotesStore.Note
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesStoreTest {

    private fun note(id: String, text: String = "t", type: String = "issue") =
        Note(id = id, createdAtMs = 1000L, text = text, type = type)

    @Test
    fun withAddedAppends() {
        val out = NotesStore.withAdded(listOf(note("a")), note("b"))
        assertEquals(listOf("a", "b"), out.map { it.id })
    }

    @Test
    fun withUpdatedChangesFieldsAndStampsUpdatedAt() {
        val out = NotesStore.withUpdated(
            listOf(note("a", text = "old", type = "issue")),
            id = "a", text = "new", type = "improvement", screenshot = "a.png", nowMs = 2000L,
        )
        val n = out.single()
        assertEquals("new", n.text)
        assertEquals("improvement", n.type)
        assertEquals("a.png", n.screenshot)
        assertEquals(1000L, n.createdAtMs)   // preserved
        assertEquals(2000L, n.updatedAtMs)   // stamped
    }

    @Test
    fun withUpdatedLeavesOthersUntouched() {
        val out = NotesStore.withUpdated(
            listOf(note("a"), note("b", text = "keep")),
            id = "a", text = "new", type = "issue", screenshot = null, nowMs = 2000L,
        )
        assertEquals("keep", out.first { it.id == "b" }.text)
        assertNull(out.first { it.id == "b" }.updatedAtMs)
    }

    @Test
    fun withStatusFlipsOnlyTarget() {
        val out = NotesStore.withStatus(listOf(note("a"), note("b")), id = "b", status = "done")
        assertEquals("open", out.first { it.id == "a" }.status)
        assertEquals("done", out.first { it.id == "b" }.status)
    }

    @Test
    fun withDeletedRemovesById() {
        val out = NotesStore.withDeleted(listOf(note("a"), note("b")), id = "a")
        assertEquals(listOf("b"), out.map { it.id })
    }

    @Test
    fun encodeDecodeRoundTrips() {
        val original = listOf(
            note("a", text = "first").copy(url = "https://x.example", androidApi = 34),
            note("b", text = "second", type = "improvement").copy(status = "done"),
        )
        val decoded = NotesStore.decode(NotesStore.encode(original))
        assertEquals(original, decoded)
    }

    @Test
    fun decodeIgnoresUnknownKeysAndMissingOptionals() {
        // forward/backward compatibility: extra field + only required fields present
        val json = """[{"id":"a","createdAtMs":5,"text":"hi","type":"issue","futureField":true}]"""
        val decoded = NotesStore.decode(json)
        assertEquals("a", decoded.single().id)
        assertEquals("open", decoded.single().status)   // default
        assertTrue(decoded.single().screenshot == null)
    }
}
