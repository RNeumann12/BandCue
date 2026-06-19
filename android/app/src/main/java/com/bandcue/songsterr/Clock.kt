package com.bandcue.songsterr

import kotlin.math.abs
import kotlin.math.max

data class ClockSample(
    val rttMs: Double,
    val offsetMs: Double
)

fun calculateClockSample(
    clientSentAt: Long,
    clientReceivedAt: Long,
    serverReceivedAt: Long,
    serverSentAt: Long
): ClockSample {
    val rttMs = clientReceivedAt - clientSentAt - (serverSentAt - serverReceivedAt)
    val offsetMs = (serverReceivedAt - clientSentAt + (serverSentAt - clientReceivedAt)) / 2.0
    return ClockSample(max(0.0, rttMs.toDouble()), offsetMs)
}

fun summarizeClock(samples: List<ClockSample>): ClockSample {
    if (samples.isEmpty()) {
        return ClockSample(0.0, 0.0)
    }

    val best = samples.sortedBy { it.rttMs }.take(5)
    return ClockSample(
        rttMs = median(best.map { it.rttMs }),
        offsetMs = median(best.map { it.offsetMs })
    )
}

fun calculateJitterMs(samples: List<ClockSample>): Double {
    if (samples.size < 2) {
        return 0.0
    }

    val offsets = samples.map { it.offsetMs }
    val center = median(offsets)
    return median(offsets.map { abs(it - center) })
}

fun delayUntilServerTime(
    scheduledServerTime: Long,
    localNow: Long,
    serverOffsetMs: Double
): Long = max(0.0, scheduledServerTime - (localNow + serverOffsetMs)).toLong()

fun median(values: List<Double>): Double {
    if (values.isEmpty()) {
        return 0.0
    }

    val sorted = values.sorted()
    val middle = sorted.size / 2
    return if (sorted.size % 2 == 1) {
        sorted[middle]
    } else {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    }
}
