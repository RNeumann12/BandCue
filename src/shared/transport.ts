import type { ControlMode, RoomClientSummary, TransportAction, TransportState } from "./protocol.js";
import type { SetlistSong } from "./protocol.js";

export const DEFAULT_SCHEDULE_DELAY_MS = 1500;

// Maximum per-device manual timing nudge. Generous enough to cover real output
// latency (e.g. Bluetooth speakers/headphones) on top of the automatic clock
// offset compensation. Mirrored in web/host-logic.js and the manual-offset input.
export const MANUAL_OFFSET_LIMIT_MS = 5000;
export const HELIX_MIN_BPM = 20;
export const HELIX_MAX_BPM = 400;
export const HELIX_MAX_BEATS_PER_MEASURE = 16;
export const HELIX_MAX_TARGET_MEASURE = 128;
// Helix timing shifts can legitimately span several bars. Keep this separate
// from the much smaller per-device calibration limit.
export const HELIX_OFFSET_LIMIT_MS = 60_000;

// Upper bound for the dynamic count-in so one terrible outlier cannot stretch
// the wait absurdly; beyond this the device is better served by calibration.
export const MAX_SCHEDULE_DELAY_MS = 5000;
// Fixed budget a command needs on top of network transit: the extension's
// dispatch lead (~400 ms), Songsterr prep, and safety margin.
const SCHEDULE_PREP_BUDGET_MS = 1000;

/**
 * Count-in length for a play, adapted to the room's timing quality. The default
 * covers typical rehearsal Wi-Fi; a transport-capable client with a slow or
 * jittery measured path extends the count-in so its command still arrives and
 * preps in time. Companion displays never extend it — they mirror, not play.
 */
export function scheduleDelayForClients(
  clients: Iterable<Pick<RoomClientSummary, "capabilities" | "clock">>,
  defaultDelayMs = DEFAULT_SCHEDULE_DELAY_MS
): number {
  let required = defaultDelayMs;
  for (const client of clients) {
    if (!client.capabilities?.some((capability) => capability.canPlay && capability.canStop)) {
      continue;
    }
    const clock = client.clock;
    if (!clock) {
      continue;
    }
    const needed = (clock.rttMs ?? 0) / 2 + (clock.jitterMs ?? 0) * 4 + SCHEDULE_PREP_BUDGET_MS;
    required = Math.max(required, needed);
  }
  return Math.round(Math.min(required, MAX_SCHEDULE_DELAY_MS));
}

export interface TransportDecision {
  accepted: boolean;
  reason?: string;
  nextState?: TransportState;
}

export interface SafetyOptions {
  armed?: boolean;
  controlMode?: ControlMode;
}

export function sanitizeHelixBpm(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value * 100) / 100;
  return rounded >= HELIX_MIN_BPM && rounded <= HELIX_MAX_BPM ? rounded : undefined;
}

export function sanitizeHelixBeatsPerMeasure(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= HELIX_MAX_BEATS_PER_MEASURE ? rounded : undefined;
}

export function sanitizeHelixTargetMeasure(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= HELIX_MAX_TARGET_MEASURE ? rounded : undefined;
}

export function clampHelixOffsetMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-HELIX_OFFSET_LIMIT_MS, Math.min(HELIX_OFFSET_LIMIT_MS, Math.round(value)));
}

export function helixMeasureDurationMs(bpm: number, beatsPerMeasure: number): number {
  return beatsPerMeasure * 60_000 / bpm;
}

export interface HelixScheduleInfo {
  /** What the configured count-in and offset asked for, before any safety floor. */
  requestedDelayMs: number;
  /** The network/device-prep floor the delay was not allowed to go below. */
  minimumDelayMs: number;
  /** The delay actually scheduled: requestedDelayMs, nudged up to minimumDelayMs if needed. */
  appliedDelayMs: number;
  /** How much later than requested the start landed (0 when the offset was fully honored). */
  extendedMs: number;
  measureDurationMs: number;
}

export function helixScheduleInfo(song: Pick<
  SetlistSong,
  "helixSyncEnabled" | "helixBpm" | "helixBeatsPerMeasure" | "helixTargetMeasure" | "helixOffsetMs"
>, minimumDelayMs = 0): HelixScheduleInfo | undefined {
  if (!song.helixSyncEnabled) {
    return undefined;
  }

  const bpm = sanitizeHelixBpm(song.helixBpm);
  const beatsPerMeasure = sanitizeHelixBeatsPerMeasure(song.helixBeatsPerMeasure);
  const targetMeasure = sanitizeHelixTargetMeasure(song.helixTargetMeasure);
  if (!bpm || !beatsPerMeasure || !targetMeasure) {
    return undefined;
  }

  const measureDurationMs = helixMeasureDurationMs(bpm, beatsPerMeasure);
  const offsetMs = clampHelixOffsetMs(song.helixOffsetMs);
  // `targetMeasure` is the number of complete Helix measures in the count-in.
  const requestedDelayMs = targetMeasure * measureDurationMs + offsetMs;

  // The Helix itself is not waiting on us: it fires the cue at measure 1 beat 1
  // and keeps running its own timeline regardless of what BandCue does next, so
  // rolling the start forward to the *next* measure (as an earlier version of
  // this did) would desync BandCue from a Helix count-in that cannot be made any
  // longer. If the room needs more lead time than the configured count-in gives,
  // the best we can do is take exactly the lead time needed -- never a whole
  // extra measure -- and accept landing slightly off the ideal downbeat.
  const appliedDelayMs = Math.max(requestedDelayMs, minimumDelayMs);

  return {
    requestedDelayMs: Math.round(requestedDelayMs),
    minimumDelayMs: Math.round(minimumDelayMs),
    appliedDelayMs: Math.round(appliedDelayMs),
    extendedMs: Math.round(appliedDelayMs - requestedDelayMs),
    measureDurationMs: Math.round(measureDurationMs)
  };
}

export function helixDelayMsForSong(song: Pick<
  SetlistSong,
  "helixSyncEnabled" | "helixBpm" | "helixBeatsPerMeasure" | "helixTargetMeasure" | "helixOffsetMs"
>, minimumDelayMs = 0): number | undefined {
  return helixScheduleInfo(song, minimumDelayMs)?.appliedDelayMs;
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
        scheduledServerTime: now,
        stopReason: "manual"
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
        scheduledServerTime: now,
        stopReason: "manual"
      }
    };
  }
