package dev.skaniti.compendium.gecko

import dev.skaniti.compendium.gecko.NotesStore.Note
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class NotesStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

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

    // ---- discardWorkingShot: dialog cancel/dismiss/empty-save cleanup ----

    @Test
    fun discardWorkingShotDeletesTheShotOfANewNote() {
        val shot = tmp.newFile("note-1.png")
        NotesStore.discardWorkingShot(existing = null, shotFile = shot)
        assertFalse(shot.exists())
    }

    @Test
    fun discardWorkingShotKeepsTheShotOfAnExistingNote() {
        // Save with an empty body on an existing note must not delete its real screenshot.
        val shot = tmp.newFile("note-2.png")
        NotesStore.discardWorkingShot(existing = note("note-2").copy(screenshot = "note-2.png"), shotFile = shot)
        assertTrue(shot.exists())
    }

    @Test
    fun discardWorkingShotToleratesAMissingFile() {
        // Cancel button and the cancel listener can both run; the second delete is a no-op.
        val shot = java.io.File(tmp.root, "never-created.png")
        NotesStore.discardWorkingShot(existing = null, shotFile = shot)
        NotesStore.discardWorkingShot(existing = null, shotFile = shot)
        assertFalse(shot.exists())
    }

    // ---- pending screenshot action: Remove/Replace deferred to Save ----

    @Test
    fun stagingFileIsASiblingOfTheShot() {
        val shot = java.io.File(tmp.root, "note-9.png")
        val staged = NotesStore.stagingFile(shot)
        assertEquals(tmp.root, staged.parentFile)
        assertEquals("note-9.pending.png", staged.name)
    }

    @Test
    fun commitPendingNoneLeavesTheSavedShot() {
        val shot = tmp.newFile("a.png").apply { writeText("old") }
        NotesStore.commitPendingShot(shot, NotesStore.PendingShot.None)
        assertEquals("old", shot.readText())
    }

    @Test
    fun commitPendingRemoveDeletesTheSavedShot() {
        val shot = tmp.newFile("a.png")
        NotesStore.commitPendingShot(shot, NotesStore.PendingShot.Remove)
        assertFalse(shot.exists())
    }

    @Test
    fun commitPendingReplaceOverwritesAndConsumesTheStagedFile() {
        val shot = tmp.newFile("a.png").apply { writeText("old") }
        val staged = tmp.newFile("a.pending.png").apply { writeText("new") }
        NotesStore.commitPendingShot(shot, NotesStore.PendingShot.Replace(staged))
        assertEquals("new", shot.readText())
        assertFalse(staged.exists())
    }

    @Test
    fun commitPendingReplaceCreatesTheShotWhenNoneExisted() {
        val shot = java.io.File(tmp.root, "b.png")
        val staged = tmp.newFile("b.pending.png").apply { writeText("new") }
        NotesStore.commitPendingShot(shot, NotesStore.PendingShot.Replace(staged))
        assertEquals("new", shot.readText())
    }

    @Test
    fun discardPendingReplaceDeletesOnlyTheStagedFile() {
        val shot = tmp.newFile("a.png").apply { writeText("old") }
        val staged = tmp.newFile("a.pending.png")
        NotesStore.discardPendingShot(NotesStore.PendingShot.Replace(staged))
        assertFalse(staged.exists())
        assertEquals("old", shot.readText())
    }

    @Test
    fun discardPendingRemoveAndNoneTouchNothing() {
        val shot = tmp.newFile("a.png")
        NotesStore.discardPendingShot(NotesStore.PendingShot.Remove)
        NotesStore.discardPendingShot(NotesStore.PendingShot.None)
        assertTrue(shot.exists())
    }

    @Test
    fun discardPendingReplaceToleratesAMissingStagedFile() {
        val staged = java.io.File(tmp.root, "gone.pending.png")
        NotesStore.discardPendingShot(NotesStore.PendingShot.Replace(staged))
        NotesStore.discardPendingShot(NotesStore.PendingShot.Replace(staged))
        assertFalse(staged.exists())
    }

    // ---- fix round 1 ----

    @Test
    fun clearStagingDeletesAStrayStagedFile() {
        val shot = java.io.File(tmp.root, "n.png")
        val stray = tmp.newFile("n.pending.png")
        NotesStore.clearStaging(shot)
        NotesStore.clearStaging(shot)
        assertFalse(stray.exists())
    }

    @Test
    fun commitAndNameReplaceNamesTheShot() {
        val shot = java.io.File(tmp.root, "n.png")
        val staged = tmp.newFile("n.pending.png").apply { writeText("x") }
        assertEquals("n.png", NotesStore.commitAndName("n", false, shot, NotesStore.PendingShot.Replace(staged)))
        assertEquals("x", shot.readText())
    }

    @Test
    fun commitAndNameRemoveGivesNull() {
        val shot = tmp.newFile("n.png")
        assertNull(NotesStore.commitAndName("n", true, shot, NotesStore.PendingShot.Remove))
        assertFalse(shot.exists())
    }

    @Test
    fun commitAndNameNoneFollowsHadShotNotTheFilesystem() {
        val stray = tmp.newFile("n.png")
        assertNull(NotesStore.commitAndName("n", false, stray, NotesStore.PendingShot.None))
        assertEquals("n.png", NotesStore.commitAndName("n", true, stray, NotesStore.PendingShot.None))
    }

    @Test
    fun commitAndNameKeepsTheOldShotWhenReplaceFails() {
        val shot = tmp.newFile("n.png").apply { writeText("old") }
        val missing = java.io.File(tmp.root, "n.pending.png")
        assertEquals("n.png", NotesStore.commitAndName("n", true, shot, NotesStore.PendingShot.Replace(missing)))
        assertEquals("old", shot.readText())
    }

    // ---- fix round 2 ----

    @Test
    fun clearStagingAlsoDeletesTheTempFile() {
        val shot = java.io.File(tmp.root, "n.png")
        val t = tmp.newFile("n.pending.png.tmp")
        NotesStore.clearStaging(shot)
        assertFalse(t.exists())
    }

    @Test
    fun sweepStagingDeletesAllStrayStagingFilesOnly() {
        val a = tmp.newFile("note-1.pending.png")
        val b = tmp.newFile("note-2.pending.png.tmp")
        val keep1 = tmp.newFile("note-3.png")
        val keep2 = tmp.newFile("notes.json")
        NotesStore.sweepStaging(tmp.root)
        assertFalse(a.exists()); assertFalse(b.exists())
        assertTrue(keep1.exists()); assertTrue(keep2.exists())
    }

    @Test
    fun commitAndNameReportsAFailedCommit() {
        val shot = tmp.newFile("n.png")
        var failed = false
        NotesStore.commitAndName(
            "n", true, shot,
            NotesStore.PendingShot.Replace(java.io.File(tmp.root, "n.pending.png")),
        ) { failed = true }
        assertTrue(failed)
    }
}
