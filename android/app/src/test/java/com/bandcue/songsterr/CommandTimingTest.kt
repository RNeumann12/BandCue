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
    fun reconciliationSchedulesMissedFuturePlay() {
        val decision = decideTransportReconciliation(
            status = "scheduled",
            action = "play",
            sequenceId = 5,
            stopReason = null,
            lastSequenceId = 4,
            lastAction = null,
            playLeadMs = 900
        )

        assertEquals(TransportReconciliation.SchedulePlay, decision)
    }

    @Test
    fun reconciliationSkipsPlayWithTooLittleLead() {
        val decision = decideTransportReconciliation(
            status = "scheduled",
            action = "play",
            sequenceId = 5,
            stopReason = null,
            lastSequenceId = 4,
            lastAction = null,
            playLeadMs = 100
        )

        assertEquals(TransportReconciliation.AdoptSequence, decision)
    }

    @Test
    fun reconciliationExecutesMissedCommandedStopAfterOurPlay() {
        val decision = decideTransportReconciliation(
            status = "stopped",
            action = "stop",
            sequenceId = 6,
            stopReason = "manual",
            lastSequenceId = 5,
            lastAction = "play",
            playLeadMs = 0
        )

        assertEquals(TransportReconciliation.ExecuteStop, decision)
    }

    @Test
    fun reconciliationIgnoresAutomaticStops() {
        val decision = decideTransportReconciliation(
            status = "stopped",
            action = "stop",
            sequenceId = 6,
            stopReason = "auto-duration",
            lastSequenceId = 5,
            lastAction = "play",
            playLeadMs = 0
        )

        assertEquals(TransportReconciliation.AdoptSequence, decision)
    }

    @Test
    fun reconciliationIgnoresStopWithoutOurPlay() {
        val decision = decideTransportReconciliation(
            status = "stopped",
            action = "stop",
            sequenceId = 6,
            stopReason = "manual",
            lastSequenceId = 0,
            lastAction = null,
            playLeadMs = 0
        )

        assertEquals(TransportReconciliation.AdoptSequence, decision)
    }

    @Test
    fun reconciliationDoesNothingOnSameSequence() {
        val decision = decideTransportReconciliation(
            status = "scheduled",
            action = "play",
            sequenceId = 5,
            stopReason = null,
            lastSequenceId = 5,
            lastAction = "play",
            playLeadMs = 900
        )

        assertEquals(TransportReconciliation.None, decision)
    }

    @Test
    fun reconciliationResetsTrackingWhenSequenceRegresses() {
        val decision = decideTransportReconciliation(
            status = "stopped",
            action = null,
            sequenceId = 0,
            stopReason = null,
            lastSequenceId = 12,
            lastAction = "play",
            playLeadMs = 0
        )

        assertEquals(TransportReconciliation.ResetTracking, decision)
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
