import type { TransportAction, TransportState } from "./protocol.js";

/**
 * Minimum lead time left on a caught-up Play for it to still start together.
 * With less there is no room for the adapter's prep, and starting late would be
 * worse than not starting. Mirrors MIN_RECONCILE_LEAD_MS in
 * extension/songsterr/background.js and CommandTiming.kt.
 */
export const MIN_RECONCILE_LEAD_MS = 250;

export type TransportReconciliation =
  /** The sequence went backwards: the coordinator restarted. Adopt its numbering. */
  | { kind: "reset-tracking" }
  /** Nothing new. */
  | { kind: "none" }
  /** Something this adapter cannot or need not act on; remember the sequence. */
  | { kind: "adopt-sequence" }
  /** No clock sample yet: decide nothing and leave the sequence for a later roomState. */
  | { kind: "wait-for-clock" }
  /** A Play this adapter missed, with enough count-in left to join it. */
  | { kind: "schedule-play" }
  /** A commanded Stop this adapter missed while it was playing. */
  | { kind: "execute-stop" };

export interface ReconcileInput {
  transport: Pick<TransportState, "status" | "action" | "sequenceId" | "scheduledServerTime" | "stopReason">;
  /** Highest transport sequence this adapter has acted on. */
  lastSequenceId: number;
  /** The action of that sequence, if any. */
  lastAction?: TransportAction;
  /**
   * Local-clock milliseconds until the Play's downbeat (manual offset included),
   * or undefined when this adapter has no clock offset yet.
   */
  playLeadMs?: number;
}

/**
 * Adapters normally act on pushed transportCommand messages. A device that was
 * disconnected while one was broadcast never sees it -- but every roomState
 * carries the authoritative transport state, so decide here how to catch up.
 *
 * Only commanded stops are reconciled: the coordinator's automatic stops never
 * broadcast a Stop command because the players already stopped on their own.
 * A Play is never judged against an unknown clock offset: the coordinator sends
 * a roomState the instant an adapter joins, before any clock sample, and an
 * assumed offset of 0 can be minutes off (a Pi coordinator without internet).
 */
export function decideTransportReconciliation(input: ReconcileInput): TransportReconciliation {
  const { transport, lastSequenceId, lastAction, playLeadMs } = input;
  if (transport.sequenceId < lastSequenceId) {
    return { kind: "reset-tracking" };
  }
  if (transport.sequenceId === lastSequenceId) {
    return { kind: "none" };
  }

  if (transport.status === "scheduled" && transport.action === "play" && transport.scheduledServerTime) {
    if (playLeadMs === undefined) {
      return { kind: "wait-for-clock" };
    }
    return playLeadMs >= MIN_RECONCILE_LEAD_MS ? { kind: "schedule-play" } : { kind: "adopt-sequence" };
  }

  const commandedStop = transport.stopReason === "manual" || transport.stopReason === "leader-disconnect";
  if (transport.status === "stopped" && commandedStop && lastAction === "play") {
    return { kind: "execute-stop" };
  }

  // Running mid-song (cannot be joined cleanly) or stopped with no play of ours
  // to undo.
  return { kind: "adopt-sequence" };
}
