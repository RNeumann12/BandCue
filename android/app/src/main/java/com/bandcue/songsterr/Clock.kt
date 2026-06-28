package com.bandcue.songsterr

import kotlin.math.abs
import kotlin.math.max

data class ClockSample(
    val rttMs: Double,
    val offsetMs: Double
)

// Clock cadence/estimator constants. Mirror of src/shared/clock.ts.
const val CLOCK_SAMPLE_WINDOW = 20
const val CLOCK_WARMUP_SAMPLES = 8
const val CLOCK_WARMUP_INTERVAL_MS = 250L
const val CLOCK_STEADY_INTERVAL_MS = 1000L
const val CLOCK_OFFSET_JUMP_MS = 250.0
const val CLOCK_OFFSET_SMOOTHING = 0.3
const val CLOCK_MIN_SAMPLES = 5

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

    val sorted = samples.sortedBy { it.rttMs }
    val best = sorted.take(5)
    return ClockSample(
        // Median RTT of the best samples drives the timing-quality badge.
        rttMs = median(best.map { it.rttMs }),
        // Offset from the single lowest-RTT sample (NTP clock filter); the
        // remaining jitter is damped over time by blendOffset.
        offsetMs = sorted.first().offsetMs
    )
}

// Smooths a measured offset into the running estimate; adopts large jumps (a real
// clock step) immediately. Mirror of blendOffset in src/shared/clock.ts.
fun blendOffset(
    previous: Double?,
    next: Double,
    smoothing: Double = CLOCK_OFFSET_SMOOTHING,
    jumpMs: Double = CLOCK_OFFSET_JUMP_MS
): Double {
    if (previous == null || !previous.isFinite()) {
        return next
    }
    if (abs(next - previous) > jumpMs) {
        return next
    }
    return previous + smoothing * (next - previous)
}

fun isClockConverged(sampleCount: Int, jitterMs: Double): Boolean =
    sampleCount >= CLOCK_MIN_SAMPLES && jitterMs < 35.0

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
