package com.bandcue.songsterr

import org.junit.Assert.assertEquals
import org.junit.Test

class CommandTimingTest {
    @Test
    fun schedulesCommandWithManualOffset() {
        val command = scheduleTransportCommand(
            action = "play",
            sequenceId = 7,
            scheduledServerTime = 10_000,
            manualOffsetMs = -100,
            localNow = 8_000,
            serverOffsetMs = 400.0
        )

        assertEquals("play", command.action)
        assertEquals(7, command.sequenceId)
        assertEquals(9_500, command.dueLocalAt)
    }
}
