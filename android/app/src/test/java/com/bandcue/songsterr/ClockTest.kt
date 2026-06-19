package com.bandcue.songsterr

import org.junit.Assert.assertEquals
import org.junit.Test

class ClockTest {
    @Test
    fun calculatesClockSampleLikeWebClient() {
        val sample = calculateClockSample(
            clientSentAt = 1_000,
            clientReceivedAt = 1_120,
            serverReceivedAt = 2_040,
            serverSentAt = 2_050
        )

        assertEquals(110.0, sample.rttMs, 0.01)
        assertEquals(985.0, sample.offsetMs, 0.01)
    }

    @Test
    fun summarizesBestRttSamples() {
        val summary = summarizeClock(
            listOf(
                ClockSample(250.0, 12.0),
                ClockSample(20.0, 4.0),
                ClockSample(10.0, 2.0),
                ClockSample(30.0, 6.0),
                ClockSample(40.0, 8.0),
                ClockSample(50.0, 10.0)
            )
        )

        assertEquals(30.0, summary.rttMs, 0.01)
        assertEquals(6.0, summary.offsetMs, 0.01)
    }

    @Test
    fun appliesServerOffsetWhenCalculatingDelay() {
        val delay = delayUntilServerTime(
            scheduledServerTime = 2_000,
            localNow = 1_000,
            serverOffsetMs = 250.0
        )

        assertEquals(750, delay)
    }
}
