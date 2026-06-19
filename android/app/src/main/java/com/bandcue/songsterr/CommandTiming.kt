package com.bandcue.songsterr

data class ScheduledCommand(
    val action: String,
    val sequenceId: Int,
    val scheduledServerTime: Long,
    val manualOffsetMs: Long,
    val dueLocalAt: Long
)

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
