import type { ControlMode, RoomClientSummary, TransportAction, TransportState } from "./protocol.js";
import type { SetlistSong } from "./protocol.js";
import { appliesToMuseScore, appliesToSongsterr } from "./song-sources.js";

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
export const SCHEDULE_PREP_BUDGET_MS = 1000;
// Floor base for a Helix-scheduled start. A button-press count-in may round the
// wait up to the comfortable default (DEFAULT_SCHEDULE_DELAY_MS) because nothing
// external is waiting on it. A Helix cue fixes the downbeat, so every millisecond
// the room takes beyond what the devices actually need lands the band that much
// behind the backing track. The floor therefore starts at the fixed prep budget --
// what any device that acts on a command needs for dispatch, IPC, and app prep,
// including one this song's app filter leaves out of the per-device maximum -- and
// is raised from there only by a device's own measured requirement.
export const HELIX_MIN_FLOOR_MS = SCHEDULE_PREP_BUDGET_MS;
// How far back a Helix cue stamp may sit before the server stops trusting it.
// The stamp is the host page's room-time reading of the keystroke instant; a
// value older than this means a cold clock estimate, a clock step, or a stalled
// page, and reclaiming that much "lost" time would start the room far too early.
export const HELIX_MAX_CUE_AGE_MS = 3000;

// Whether a transport-capable adapter's app is even in play for the current
// song. A MuseScore adapter sitting idle during a Songsterr/Helix-only song
// (or vice versa) never touches this song, so its setup lead shouldn't stretch
// everyone else's count-in.
function appAppliesToSong(app: string, song: Pick<
  SetlistSong,
  "sourceType" | "source" | "songsterrUrl" | "songsterrBassUrl" | "songsterrDrumUrl" | "museScoreSource"
>): boolean {
  if (app === "musescore") {
    return appliesToMuseScore(song as SetlistSong);
  }
  if (app === "songsterr") {
    return appliesToSongsterr(song as SetlistSong);
  }
  return true;
}

/**
 * Count-in length for a play, adapted to the room's timing quality. The default
 * covers typical rehearsal Wi-Fi; a transport-capable client with a slow or
 * jittery measured path extends the count-in so its command still arrives and
 * preps in time. Companion displays never extend it — they mirror, not play.
 * When `song` is given, only adapters whose app actually applies to that song
 * can extend the count-in: an adapter for an app the song doesn't use will
 * never spawn/activate anything, so it has nothing to prep for.
 */
export function scheduleDelayForClients(
  clients: Iterable<Pick<RoomClientSummary, "capabilities" | "clock" | "status">>,
  defaultDelayMs = DEFAULT_SCHEDULE_DELAY_MS,
  song?: Pick<
    SetlistSong,
    "sourceType" | "source" | "songsterrUrl" | "songsterrBassUrl" | "songsterrDrumUrl" | "museScoreSource"
  >
): number {
  let required = defaultDelayMs;
  for (const client of clients) {
    const transportCapability = client.capabilities?.find(
      (capability) => capability.canPlay && capability.canStop
    );
    if (!transportCapability) {
      continue;
    }
    if (song && !appAppliesToSong(transportCapability.app, song)) {
      continue;
    }
    const clock = client.clock;
    if (clock) {
      const needed = (clock.rttMs ?? 0) / 2 + (clock.jitterMs ?? 0) * 4 + SCHEDULE_PREP_BUDGET_MS;
      required = Math.max(required, needed);
    }
    // A desktop adapter whose control path needs real setup time before the
    // downbeat (e.g. spawning a shell and activating the target app) reports
    // that need directly, so its Play command gets a count-in long enough to
    // land on time instead of always firing after the deadline.
    const requiredLeadMs = client.status?.requiredLeadMs;
    if (typeof requiredLeadMs === "number" && Number.isFinite(requiredLeadMs)) {
      required = Math.max(required, requiredLeadMs + SCHEDULE_PREP_BUDGET_MS);
    }
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

/**
 * The room floor a Helix start has to clear. Same per-device requirement the
 * normal count-in uses, but without rounding up to the default count-in: see
 * HELIX_MIN_FLOOR_MS.
 */
export function helixMinimumDelayMs(
  clients: Iterable<Pick<RoomClientSummary, "capabilities" | "clock" | "status">>,
  song?: Pick<
    SetlistSong,
    "sourceType" | "source" | "songsterrUrl" | "songsterrBassUrl" | "songsterrDrumUrl" | "museScoreSource"
  >
): number {
  return scheduleDelayForClients(clients, HELIX_MIN_FLOOR_MS, song);
}

/**
 * How long the Helix cue spent getting from the pedal's downbeat to this server,
 * in milliseconds, given the host's room-time stamp of the keystroke. That time
 * has already been spent when the room is scheduled, so it comes off the count-in
 * instead of being silently added to it. Missing, future, or implausibly old
 * stamps yield 0 — the old behavior of counting the full count-in from now.
 */
export function helixCueElapsedMs(cueAtServerTime: number | undefined, now: number): number {
  if (typeof cueAtServerTime !== "number" || !Number.isFinite(cueAtServerTime)) {
    return 0;
  }

  const elapsed = now - cueAtServerTime;
  if (!(elapsed > 0)) {
    return 0;
  }

  return Math.min(Math.round(elapsed), HELIX_MAX_CUE_AGE_MS);
}

export interface HelixScheduleInfo {
  /** The configured count-in plus offset, measured from the Helix cue itself. */
  countInMs: number;
  /** Time the cue had already spent in transit when the server scheduled the room. */
  cueLatencyMs: number;
  /** What is left of the count-in from now: countInMs - cueLatencyMs, before any floor. */
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
>, minimumDelayMs = 0, cueLatencyMs = 0): HelixScheduleInfo | undefined {
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
  const countInMs = targetMeasure * measureDurationMs + offsetMs;
  // The count-in is anchored to the *cue*, not to the moment its request reached
  // this server. Whatever the keystroke spent on input handling, Wi-Fi, and the
  // server's own queue is count-in time that has already elapsed, so waiting the
  // full countInMs from now would start the whole room exactly that late against
  // the Helix -- and the jitter of that path would show up as start-to-start
  // wobble even when the devices themselves are perfectly in sync.
  const requestedDelayMs = countInMs - cueLatencyMs;

  // The Helix itself is not waiting on us: it fires the cue at measure 1 beat 1
  // and keeps running its own timeline regardless of what BandCue does next, so
  // rolling the start forward to the *next* measure (as an earlier version of
  // this did) would desync BandCue from a Helix count-in that cannot be made any
  // longer. If the room needs more lead time than the configured count-in gives,
  // the best we can do is take exactly the lead time needed -- never a whole
  // extra measure -- and accept landing slightly off the ideal downbeat.
  const appliedDelayMs = Math.max(requestedDelayMs, minimumDelayMs);

  return {
    countInMs: Math.round(countInMs),
    cueLatencyMs: Math.round(cueLatencyMs),
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
>, minimumDelayMs = 0, cueLatencyMs = 0): number | undefined {
  return helixScheduleInfo(song, minimumDelayMs, cueLatencyMs)?.appliedDelayMs;
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
