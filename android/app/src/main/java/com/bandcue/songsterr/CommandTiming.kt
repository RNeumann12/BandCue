package com.bandcue.songsterr

data class ScheduledCommand(
    val action: String,
    val sequenceId: Int,
    val scheduledServerTime: Long,
    val manualOffsetMs: Long,
    val dueLocalAt: Long
)

enum class StopControlPlan {
    NoOpAlreadyStopped,
    MediaSessionPause,
    AccessibilityConfidentPauseOnly,
    FailClosed
}

fun scheduleTransportCommand(
    action: String,
    sequenceId: Int,
    scheduledServerTime: Long,
    manualOffsetMs: Long,
    localNow: Long,
    serverOffsetMs: Double
): ScheduledCommand {
    val adjustedServerTime = scheduledServerTime + manualOffsetMs
    val delayMs = delayUntilServerTime(adjustedServerTime, localNow, serverOffsetMs)
    return ScheduledCommand(
        action = action,
        sequenceId = sequenceId,
        scheduledServerTime = scheduledServerTime,
        manualOffsetMs = manualOffsetMs,
        dueLocalAt = localNow + delayMs
    )
}

fun decideStopControlPlan(
    playbackState: String,
    hasMediaController: Boolean,
    accessibilityEnabled: Boolean
): StopControlPlan {
    return when {
        playbackState == "stopped" -> StopControlPlan.NoOpAlreadyStopped
        hasMediaController -> StopControlPlan.MediaSessionPause
        accessibilityEnabled -> StopControlPlan.AccessibilityConfidentPauseOnly
        else -> StopControlPlan.FailClosed
    }
}
