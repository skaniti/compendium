package dev.skaniti.compendium

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class AtomicWriteTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun writesContentAndLeavesNoTempFile() {
        val target = File(tmp.root, "tabs.json")
        AtomicWrite.write(target, """{"a":1}""")
        assertEquals("""{"a":1}""", target.readText())
        assertEquals(listOf("tabs.json"), tmp.root.list()!!.toList())
    }

    @Test
    fun replacesExistingContent() {
        val target = File(tmp.root, "tabs.json")
        target.writeText("old")
        AtomicWrite.write(target, "new")
        assertEquals("new", target.readText())
    }

    @Test
    fun failedWriteLeavesTargetUntouched() {
        val target = File(tmp.root, "tabs.json")
        target.writeText("old")
        // A directory squatting on the temp path makes the temp write fail.
        File(tmp.root, "tabs.json.tmp").mkdir()
        try {
            AtomicWrite.write(target, "new")
            fail("expected IOException")
        } catch (e: IOException) {
            // expected
        }
        assertEquals("old", target.readText())
    }
}
