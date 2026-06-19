import type { ControlMode, RoomClientSummary, TransportAction, TransportState } from "./protocol.js";

export const DEFAULT_SCHEDULE_DELAY_MS = 1500;

export interface TransportDecision {
  accepted: boolean;
  reason?: string;
  nextState?: TransportState;
}

export interface SafetyOptions {
  armed?: boolean;
  controlMode?: ControlMode;
}

export function hasReadyTransportCapability(client: RoomClientSummary): boolean {
  return Boolean(
    client.status?.ready &&
      client.capabilities.some((capability) => capability.canPlay && capability.canStop)
  );
}

export function decideTransportRequest(
  current: TransportState,
  client: RoomClientSummary,
  action: TransportAction,
  now: number,
  delayMs = DEFAULT_SCHEDULE_DELAY_MS,
  safety: SafetyOptions = {}
): TransportDecision {
  const controlMode = safety.controlMode ?? "leader-stop";

  if (action === "play") {
    if (current.status !== "stopped") {
      return { accepted: false, reason: "Playback is already scheduled or running." };
    }

    if (safety.armed === false) {
      return { accepted: false, reason: "Playback is not armed." };
    }

    if (controlMode === "host-only" && client.role !== "host") {
      return { accepted: false, reason: "Only the host can start playback in host-only mode." };
    }

    if (client.role !== "host" && !hasReadyTransportCapability(client)) {
      return { accepted: false, reason: "Only a ready desktop adapter or host can start playback." };
    }

    return {
      accepted: true,
      nextState: {
        status: "scheduled",
        leaderId: client.id,
        action,
        sequenceId: current.sequenceId + 1,
        scheduledServerTime: now + delayMs
      }
    };
  }

  if (current.status === "stopped") {
    return { accepted: false, reason: "Playback is already stopped." };
  }

  if (controlMode === "host-only" && client.role !== "host") {
    return { accepted: false, reason: "Only the host can stop playback in host-only mode." };
  }

  if (controlMode === "everyone-can-stop") {
    return {
      accepted: true,
      nextState: {
        status: "stopped",
        leaderId: client.id,
        action,
        sequenceId: current.sequenceId + 1,
        scheduledServerTime: now
      }
    };
  }

  if (client.role !== "host" && client.id !== current.leaderId) {
    return { accepted: false, reason: "Only the current leader or host can stop playback." };
  }

  return {
    accepted: true,
    nextState: {
      status: "stopped",
      leaderId: client.id,
      action,
      sequenceId: current.sequenceId + 1,
      scheduledServerTime: now
    }
  };
}
