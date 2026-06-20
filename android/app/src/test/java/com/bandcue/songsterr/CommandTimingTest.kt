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

    @Test
    fun stopIsNoOpWhenPlaybackAlreadyStopped() {
        val plan = decideStopControlPlan(
            playbackState = "stopped",
            hasMediaController = true,
            accessibilityEnabled = true
        )

        assertEquals(StopControlPlan.NoOpAlreadyStopped, plan)
    }

    @Test
    fun stopUsesMediaSessionPauseWhenControllerCanReceivePause() {
        val plan = decideStopControlPlan(
            playbackState = "playing",
            hasMediaController = true,
            accessibilityEnabled = false
        )

        assertEquals(StopControlPlan.MediaSessionPause, plan)
    }

    @Test
    fun stopAllowsOnlyConfidentAccessibilityFallbackWithoutController() {
        val plan = decideStopControlPlan(
            playbackState = "unknown",
            hasMediaController = false,
            accessibilityEnabled = true
        )

        assertEquals(StopControlPlan.AccessibilityConfidentPauseOnly, plan)
    }

    @Test
    fun stopFailsClosedWhenPlaybackStateIsUnknownAndNoFallbackIsAvailable() {
        val plan = decideStopControlPlan(
            playbackState = "unknown",
            hasMediaController = false,
            accessibilityEnabled = false
        )

        assertEquals(StopControlPlan.FailClosed, plan)
    }
}
