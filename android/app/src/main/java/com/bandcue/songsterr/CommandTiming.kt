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

// Minimum lead time left on a reconciled play for it to still start together;
// with less than this there is no room to prep Songsterr, and starting late
// would be worse than not starting. Mirror of MIN_RECONCILE_LEAD_MS in
// extension/songsterr/background.js.
const val MIN_RECONCILE_LEAD_MS = 250L

enum class TransportReconciliation {
    // Sequence regressed: the coordinator restarted; reset local tracking.
    ResetTracking,
    // Nothing new, or nothing that can be joined safely; remember the sequence.
    AdoptSequence,
    None,
    SchedulePlay,
    ExecuteStop
}

/**
 * Adapters normally act on pushed transportCommand messages. A device that was
 * disconnected while one was broadcast never sees it -- but every roomState
 * carries the authoritative transport state, so decide here how to catch up.
 * Only commanded stops (manual / leader-disconnect) are reconciled: the
 * coordinator's automatic stops never broadcast a Stop command because the
 * players already stopped on their own. Mirror of
 * reconcileTransportFromRoomState in extension/songsterr/background.js.
 */
fun decideTransportReconciliation(
    status: String,
    action: String?,
    sequenceId: Int,
    stopReason: String?,
    lastSequenceId: Int,
    lastAction: String?,
    playLeadMs: Long
): TransportReconciliation {
    if (sequenceId < lastSequenceId) {
        return TransportReconciliation.ResetTracking
    }
    if (sequenceId == lastSequenceId) {
        return TransportReconciliation.None
    }
    if (status == "scheduled" && action == "play") {
        return if (playLeadMs >= MIN_RECONCILE_LEAD_MS) {
            TransportReconciliation.SchedulePlay
        } else {
            // Too late to start together; skip rather than joining off-beat.
            TransportReconciliation.AdoptSequence
        }
    }
    val commandedStop = stopReason == "manual" || stopReason == "leader-disconnect"
    if (status == "stopped" && commandedStop && lastAction == "play") {
        return TransportReconciliation.ExecuteStop
    }
    return TransportReconciliation.AdoptSequence
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
