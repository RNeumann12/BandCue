// Pure host-page logic, extracted from app.js so it can be unit tested without a
// DOM or a live WebSocket. app.js imports these and keeps only the rendering and
// socket wiring. Everything here must stay free of DOM, globals, and I/O.

// --- Setlist song model ---------------------------------------------------

export function createId() {
  return crypto.randomUUID?.() ?? `song-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function sanitizeDurationMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return undefined;
  }

  const rounded = Math.round(number);
  return rounded > 0 && rounded <= 24 * 60 * 60 * 1000 ? rounded : undefined;
}

export function normalizeDurationSource(value) {
  return value === "adapter" || value === "manual" ? value : "manual";
}

export const HELIX_MIN_BPM = 20;
export const HELIX_MAX_BPM = 400;
export const HELIX_MAX_BEATS_PER_MEASURE = 16;
export const HELIX_MAX_TARGET_MEASURE = 128;
export const HELIX_OFFSET_LIMIT_MS = 60_000;

// Trim a setlist song for publishing/persisting: drop empty optional fields and
// only keep a duration source when there is a usable duration.
export function normalizeSong(song) {
  if (!song) {
    return undefined;
  }

  return {
    id: song.id,
    title: song.title,
    sourceType: song.sourceType,
    source: song.source || undefined,
    songsterrUrl: song.songsterrUrl || undefined,
    songsterrBassUrl: song.songsterrBassUrl || undefined,
    songsterrDrumUrl: song.songsterrDrumUrl || undefined,
    museScoreSource: song.museScoreSource || undefined,
    durationMs: sanitizeDurationMs(song.durationMs),
    durationSource: sanitizeDurationMs(song.durationMs) ? (song.durationSource || "manual") : undefined,
    helixSyncEnabled: Boolean(song.helixSyncEnabled),
    helixBpm: sanitizeHelixBpm(song.helixBpm),
    helixBeatsPerMeasure: sanitizeHelixBeatsPerMeasure(song.helixBeatsPerMeasure),
    helixTargetMeasure: sanitizeHelixTargetMeasure(song.helixTargetMeasure),
    helixOffsetMs: clampHelixOffsetMs(song.helixOffsetMs),
    notes: song.notes || undefined
  };
}

// Validate and normalize a song loaded from storage or an imported file. Returns
// undefined for entries without a usable title so callers can filter them out.
export function normalizeStoredSong(song) {
  if (!song || typeof song.title !== "string" || !song.title.trim()) {
    return undefined;
  }

  const sourceType = ["songsterr", "musescore", "other"].includes(song.sourceType)
    ? song.sourceType
    : "other";

  return {
    id: typeof song.id === "string" && song.id ? song.id : createId(),
    title: song.title.trim(),
    sourceType,
    source: typeof song.source === "string" ? song.source.trim() : "",
    songsterrUrl: typeof song.songsterrUrl === "string" ? song.songsterrUrl.trim() : "",
    songsterrBassUrl: typeof song.songsterrBassUrl === "string" ? song.songsterrBassUrl.trim() : "",
    songsterrDrumUrl: typeof song.songsterrDrumUrl === "string" ? song.songsterrDrumUrl.trim() : "",
    museScoreSource: typeof song.museScoreSource === "string" ? song.museScoreSource.trim() : "",
    durationMs: sanitizeDurationMs(song.durationMs),
    durationSource: sanitizeDurationMs(song.durationMs) ? normalizeDurationSource(song.durationSource) : undefined,
    helixSyncEnabled: Boolean(song.helixSyncEnabled),
    helixBpm: sanitizeHelixBpm(Number(song.helixBpm)),
    helixBeatsPerMeasure: sanitizeHelixBeatsPerMeasure(Number(song.helixBeatsPerMeasure)) ?? 4,
    helixTargetMeasure: sanitizeHelixTargetMeasure(Number(song.helixTargetMeasure)) ?? 2,
    helixOffsetMs: clampHelixOffsetMs(Number(song.helixOffsetMs)),
    notes: typeof song.notes === "string" ? song.notes.trim() : ""
  };
}

export function sanitizeHelixBpm(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return undefined;
  }

  const rounded = Math.round(number * 100) / 100;
  return rounded >= HELIX_MIN_BPM && rounded <= HELIX_MAX_BPM ? rounded : undefined;
}

export function sanitizeHelixBeatsPerMeasure(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return undefined;
  }

  const rounded = Math.round(number);
  return rounded >= 1 && rounded <= HELIX_MAX_BEATS_PER_MEASURE ? rounded : undefined;
}

export function sanitizeHelixTargetMeasure(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return undefined;
  }

  const rounded = Math.round(number);
  return rounded >= 1 && rounded <= HELIX_MAX_TARGET_MEASURE ? rounded : undefined;
}

export function clampHelixOffsetMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(-HELIX_OFFSET_LIMIT_MS, Math.min(HELIX_OFFSET_LIMIT_MS, Math.round(number)));
}

export function helixMeasureDurationMs(bpm, beatsPerMeasure) {
  return beatsPerMeasure * 60000 / bpm;
}

export function helixDelayMsForSong(song, minimumDelayMs = 0) {
  if (!song?.helixSyncEnabled) {
    return undefined;
  }

  const bpm = sanitizeHelixBpm(song.helixBpm);
  const beatsPerMeasure = sanitizeHelixBeatsPerMeasure(song.helixBeatsPerMeasure);
  const targetMeasure = sanitizeHelixTargetMeasure(song.helixTargetMeasure);
  if (!bpm || !beatsPerMeasure || !targetMeasure) {
    return undefined;
  }

  const measureDurationMs = helixMeasureDurationMs(bpm, beatsPerMeasure);
  const delayMs = targetMeasure * measureDurationMs + clampHelixOffsetMs(song.helixOffsetMs);
  // The Helix fires its cue at measure 1 beat 1 and keeps running its own timeline
  // regardless of BandCue, so a count-in that's too short to clear the network/
  // device-prep floor can only be nudged up to that floor -- never rolled forward
  // a whole extra measure, which would start BandCue a full measure behind Helix.
  return Math.round(Math.max(delayMs, minimumDelayMs));
}

// Mirrors of the coordinator's scheduling floor (src/shared/transport.ts). Kept
// here so the host can tell the player *before* a start whether the configured
// count-in clears what this room needs, instead of only reporting it afterwards.
export const SCHEDULE_PREP_BUDGET_MS = 1000;
export const MAX_SCHEDULE_DELAY_MS = 5000;
export const HELIX_MIN_FLOOR_MS = SCHEDULE_PREP_BUDGET_MS;

function helixAppAppliesToSong(app, song) {
  if (app === "musescore") return appliesToMuseScore(song);
  if (app === "songsterr") return appliesToSongsterr(song);
  return true;
}

/**
 * The lead time this room needs right now for a Helix start: the largest
 * per-device requirement among the transport-capable clients that this song
 * actually uses. Mirror of helixMinimumDelayMs in src/shared/transport.ts.
 */
export function helixMinimumDelayMs(state, song) {
  let required = HELIX_MIN_FLOOR_MS;
  for (const client of state?.clients ?? []) {
    const transportCapability = (client.capabilities ?? []).find(
      (capability) => capability.canPlay && capability.canStop
    );
    if (!transportCapability) {
      continue;
    }
    if (song && !helixAppAppliesToSong(transportCapability.app, song)) {
      continue;
    }
    const clock = client.clock;
    if (clock) {
      required = Math.max(
        required,
        (clock.rttMs ?? 0) / 2 + (clock.jitterMs ?? 0) * 4 + SCHEDULE_PREP_BUDGET_MS
      );
    }
    const requiredLeadMs = client.status?.requiredLeadMs;
    if (Number.isFinite(requiredLeadMs)) {
      required = Math.max(required, requiredLeadMs + SCHEDULE_PREP_BUDGET_MS);
    }
  }
  return Math.round(Math.min(required, MAX_SCHEDULE_DELAY_MS));
}

/**
 * Whether the current song's Helix count-in is long enough for this room, and
 * if not, how many count-in measures it would take. `undefined` when the song
 * isn't Helix-synced or is missing the numbers to say anything.
 */
export function helixLeadReadiness(state, song) {
  if (!song?.helixSyncEnabled) {
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
  const countInMs = targetMeasure * measureDurationMs + offsetMs;
  const minimumDelayMs = helixMinimumDelayMs(state, song);
  // How many complete count-in measures would clear the floor with this offset.
  const measuresNeeded = Math.max(
    1,
    Math.ceil((minimumDelayMs - offsetMs) / measureDurationMs)
  );

  return {
    bpm,
    beatsPerMeasure,
    targetMeasure,
    offsetMs,
    measureDurationMs: Math.round(measureDurationMs),
    countInMs: Math.round(countInMs),
    minimumDelayMs,
    spareMs: Math.round(countInMs - minimumDelayMs),
    measuresNeeded,
    ok: countInMs >= minimumDelayMs
  };
}

// The Helix cue reaches BandCue as a Play keystroke on this page. `timeStamp` is
// written when the browser created the event -- before any of our JS ran -- so it
// is a closer reading of the pedal's downbeat than Date.now() inside the handler,
// and it survives the page being busy when the key arrives. Converted to room
// time it lets the coordinator take the cue's travel time off the count-in.
export const HOTKEY_CUE_MAX_AGE_MS = 1500;

export function hostCueServerTime({ eventTimeStampMs, timeOriginMs, localNowMs, serverOffsetMs }) {
  if (!Number.isFinite(serverOffsetMs)) {
    // No trusted clock offset yet: a "room time" stamp would be a guess, and a
    // wrong one moves the downbeat. Let the coordinator time the cue instead.
    return undefined;
  }

  const eventLocalMs = Number.isFinite(timeOriginMs) && Number.isFinite(eventTimeStampMs)
    ? timeOriginMs + eventTimeStampMs
    : NaN;
  // Only trust a stamp that sits just before now: a synthetic event, or one from
  // a different time origin, would otherwise claim the cue was long past.
  const usable = Number.isFinite(eventLocalMs)
    && eventLocalMs <= localNowMs
    && localNowMs - eventLocalMs <= HOTKEY_CUE_MAX_AGE_MS;

  return Math.round((usable ? eventLocalMs : localNowMs) + serverOffsetMs);
}

export function applyGlobalHelixSettings(song, settings) {
  const normalized = normalizeSong(song);
  if (!normalized) {
    return undefined;
  }

  return {
    ...normalized,
    helixSyncEnabled: Boolean(settings?.enabled) && normalized.helixSyncEnabled,
    helixOffsetMs: clampHelixOffsetMs(
      (normalized.helixOffsetMs || 0) + clampHelixOffsetMs(Number(settings?.offsetMs || 0))
    )
  };
}

// Setlist navigation. -1 means "no selection". length 0 yields -1.
export function nextSongIndex(currentIndex, length) {
  if (length <= 0) {
    return -1;
  }
  return currentIndex < 0 ? 0 : (currentIndex + 1) % length;
}

export function previousSongIndex(currentIndex, length) {
  if (length <= 0) {
    return -1;
  }
  return currentIndex <= 0 ? length - 1 : currentIndex - 1;
}

// Where the current-song pointer lands after removing the song at removedIndex.
export function adjustCurrentIndexAfterRemoval(currentIndex, removedIndex) {
  if (currentIndex === removedIndex) {
    return -1;
  }
  if (currentIndex > removedIndex) {
    return currentIndex - 1;
  }
  return currentIndex;
}

// --- Per-app source resolution (mirrors src/shared/song-sources.ts) -------
// A dedicated field wins, otherwise the primary source is used when its type
// matches.

export function songsterrReference(song) {
  const dedicated = song?.songsterrUrl?.trim();
  if (dedicated) {
    return dedicated;
  }
  return song?.sourceType === "songsterr" ? (song.source?.trim() ?? "") : "";
}

export function songsterrReferences(song) {
  const references = [
    songsterrReference(song),
    song?.songsterrBassUrl?.trim() ?? "",
    song?.songsterrDrumUrl?.trim() ?? ""
  ].filter(Boolean);
  return [...new Set(references)];
}

export function museScoreReference(song) {
  const dedicated = song?.museScoreSource?.trim();
  if (dedicated) {
    return dedicated;
  }
  return song?.sourceType === "musescore" ? (song.source?.trim() ?? "") : "";
}

export function appliesToMuseScore(song) {
  return Boolean(song) && (song.sourceType === "musescore" || Boolean(song.museScoreSource?.trim()));
}

export function appliesToSongsterr(song) {
  return Boolean(song) && (
    song.sourceType === "songsterr" ||
    Boolean(song.songsterrUrl?.trim()) ||
    Boolean(song.songsterrBassUrl?.trim()) ||
    Boolean(song.songsterrDrumUrl?.trim())
  );
}

export function getSongsterrUrl(song) {
  const reference = songsterrReference(song);
  if (!reference) {
    return "";
  }
  try {
    const url = new URL(reference);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function getAnySongsterrUrl(song) {
  for (const reference of songsterrReferences(song)) {
    const url = normalizeOpenableUrl(reference);
    if (url) {
      return url;
    }
  }
  return "";
}

function normalizeOpenableUrl(reference) {
  if (!reference) {
    return "";
  }
  try {
    const url = new URL(reference);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

// A song is openable when at least one adapter can resolve a reference for it.
export function isOpenableSong(song) {
  return Boolean(song) && (appliesToMuseScore(song) || Boolean(getAnySongsterrUrl(song)));
}

// --- Clock / timing math --------------------------------------------------
// Mirror of src/shared/clock.ts. Keep the two in sync.

export const CLOCK_SAMPLE_WINDOW = 20;
export const CLOCK_WARMUP_SAMPLES = 8;
export const CLOCK_WARMUP_INTERVAL_MS = 250;
export const CLOCK_STEADY_INTERVAL_MS = 1000;
export const CLOCK_OFFSET_JUMP_MS = 250;
export const CLOCK_OFFSET_SMOOTHING = 0.3;
export const CLOCK_MIN_SAMPLES = 5;

export function calculateClockSample(clientSentAt, clientReceivedAt, serverReceivedAt, serverSentAt) {
  const rttMs = clientReceivedAt - clientSentAt - (serverSentAt - serverReceivedAt);
  const offsetMs = (serverReceivedAt - clientSentAt + (serverSentAt - clientReceivedAt)) / 2;
  return { rttMs: Math.max(0, rttMs), offsetMs };
}

export function summarizeClock(clockSamples) {
  if (!clockSamples.length) {
    return { rttMs: 0, offsetMs: 0 };
  }
  const sorted = [...clockSamples].sort((a, b) => a.rttMs - b.rttMs);
  const best = sorted.slice(0, 5);
  return {
    // Median RTT of the best samples drives the timing-quality badge.
    rttMs: median(best.map((sample) => sample.rttMs)),
    // Offset from the single lowest-RTT sample (least queuing delay = most accurate).
    offsetMs: sorted[0].offsetMs
  };
}

// Smooths a measured offset into the running estimate; adopts large jumps (a real
// clock step) immediately. Mirror of blendOffset in src/shared/clock.ts.
export function blendOffset(previous, next, smoothing = CLOCK_OFFSET_SMOOTHING, jumpMs = CLOCK_OFFSET_JUMP_MS) {
  if (previous === undefined || !Number.isFinite(previous)) {
    return next;
  }
  if (Math.abs(next - previous) > jumpMs) {
    return next;
  }
  return previous + smoothing * (next - previous);
}

export function isClockConverged(sampleCount, jitterMs) {
  return (sampleCount ?? 0) >= CLOCK_MIN_SAMPLES && (jitterMs ?? 0) < 35;
}

export function calculateJitterMs(clockSamples) {
  if (clockSamples.length < 2) return 0;
  const offsets = clockSamples.map((sample) => sample.offsetMs);
  const center = median(offsets);
  return median(offsets.map((offset) => Math.abs(offset - center)));
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Mirror of MANUAL_OFFSET_LIMIT_MS in src/shared/transport.ts and the
// manual-offset input bounds in web/app.js. Keep all three in sync.
export const MANUAL_OFFSET_LIMIT_MS = 5000;

export function clampManualOffset(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-MANUAL_OFFSET_LIMIT_MS, Math.min(MANUAL_OFFSET_LIMIT_MS, Math.round(value)));
}

// Calibrations are keyed by device name so they re-apply when a device reconnects
// with a new client id.
export function getCalibrationKey(device) {
  return String(device.deviceName || "").trim().toLowerCase();
}

export function getTimingQuality(clock) {
  if (!clock) {
    return { label: "pending", className: "warn" };
  }

  // Until enough samples have arrived the offset can't be trusted yet, so surface
  // a distinct "syncing" state rather than a (misleadingly green) quality badge.
  if ((clock.sampleCount ?? 0) < CLOCK_MIN_SAMPLES) {
    return { label: "syncing…", className: "warn" };
  }

  if ((clock.rttMs ?? 0) >= 180 || (clock.jitterMs ?? 0) >= 35) {
    return { label: "unstable", className: "bad" };
  }

  if ((clock.rttMs ?? 0) >= 100 || (clock.jitterMs ?? 0) >= 20) {
    return { label: "watch", className: "warn" };
  }

  return { label: "tight", className: "good" };
}

// --- Transport / safety decisions -----------------------------------------

export function getReadyAdapters(state) {
  return state?.clients.filter(
    (device) => device.role === "desktop-adapter" && device.status?.ready
  ) ?? [];
}

export function canHostPlay(state) {
  return Boolean(
    state &&
      state.safety?.armed &&
      state.transport.status === "stopped" &&
      getReadyAdapters(state).length > 0
  );
}

export function playBlockedReason(state) {
  if (!state) return "Room state is not ready yet.";
  if (state.transport.status !== "stopped") return "Transport is already active.";
  if (!state.safety?.armed) return "Arm playback before pressing Play.";
  if (!getReadyAdapters(state).length) {
    return "No ready desktop adapter yet. Connect MuseScore or Songsterr before starting.";
  }
  return "Play is not available yet.";
}

// --- Setlist automation settings ------------------------------------------
// Two independent host switches, both living next to Arm/Play/Stop:
//   advance -- when a song ends by itself, select the next entry and load it
//   start   -- once that entry has loaded, arm and play it too
// `start` is only consulted while `advance` is on; it is still remembered when
// `advance` is off so toggling the pair back on restores the host's choice.
export function normalizeAutoRunSettings(value) {
  return {
    advance: Boolean(value?.advance),
    // Default on: this is what the old single "setlist mode" toggle did.
    start: value?.start !== false
  };
}

export function describeAutoRun(settings) {
  if (!settings?.advance) {
    return "Manual: load and start every song yourself.";
  }

  return settings.start
    ? "At the end of a song: load the next one and start it."
    : "At the end of a song: load the next one, then wait for Play.";
}

// Decide what the setlist auto-runner should do while a song is loading on the
// adapters. Kept pure so the timing branches can be unit tested without a DOM.
//   - "wait":    keep waiting (transport busy, adapter not ready, or still settling)
//   - "play":    the song is loaded enough to arm and start
//   - "timeout": no adapter ever became ready; the caller should abort the run
// `needsAdapter` is false for songs nothing can open (e.g. plain "other" notes),
// in which case there is nothing to load and playback can start immediately.
export function setlistLoadDecision(state, { needsAdapter, elapsedMs, settleMs, timeoutMs }) {
  if (state?.transport?.status && state.transport.status !== "stopped") {
    return "wait";
  }

  if (!needsAdapter) {
    return "play";
  }

  if (!getReadyAdapters(state).length) {
    return elapsedMs >= timeoutMs ? "timeout" : "wait";
  }

  return elapsedMs >= settleMs ? "play" : "wait";
}

export function shouldAdvanceSetlistOnStop(state, previousTransportStatus) {
  if (state?.transport?.status !== "stopped" || previousTransportStatus !== "running") {
    return false;
  }

  return state.transport.stopReason === "auto-duration" ||
    state.transport.stopReason === "auto-playback-ended";
}

// --- Host hotkeys ---------------------------------------------------------

export const DEFAULT_HOST_HOTKEYS = Object.freeze([
  { action: "toggle-arm", key: "a", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, label: "Ctrl+Alt+A" },
  { action: "play", key: "p", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, label: "Ctrl+Alt+P" },
  { action: "stop", key: "s", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, label: "Ctrl+Alt+S" },
  { action: "next-song", key: "n", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, label: "Ctrl+Alt+N" },
  { action: "previous-song", key: "b", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, label: "Ctrl+Alt+B" },
  { action: "open-current-song", key: "o", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, label: "Ctrl+Alt+O" },
  { action: "toggle-auto-advance", key: "r", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, label: "Ctrl+Alt+R" },
  { action: "toggle-auto-start", key: "t", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, label: "Ctrl+Alt+T" }
]);

export function hostHotkeyActionForEvent(event) {
  if (!event || event.repeat || isEditableHotkeyTarget(event.target)) {
    return undefined;
  }

  const key = String(event.key || "").toLowerCase();
  const match = DEFAULT_HOST_HOTKEYS.find((hotkey) => (
    hotkey.key === key &&
    Boolean(event.ctrlKey) === hotkey.ctrlKey &&
    Boolean(event.altKey) === hotkey.altKey &&
    Boolean(event.shiftKey) === hotkey.shiftKey &&
    Boolean(event.metaKey) === hotkey.metaKey
  ));

  return match?.action;
}

function isEditableHotkeyTarget(target) {
  if (!target || typeof target !== "object") {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = String(target.tagName || "").toLowerCase();
  if (["input", "select", "textarea"].includes(tagName)) {
    return true;
  }

  return typeof target.closest === "function" && Boolean(target.closest("[contenteditable=''], [contenteditable='true']"));
}

export function collectWarnings(state, readyAdapters, desktopAdapters) {
  const warnings = [];

  if (!desktopAdapters.length) {
    warnings.push("No desktop adapters connected. Play will not control MuseScore or Songsterr yet.");
  } else if (!readyAdapters.length) {
    warnings.push("Desktop adapters are connected, but none are ready.");
  }

  for (const device of desktopAdapters) {
    if (!device.status?.ready) {
      warnings.push(`${device.deviceName}: ${device.status?.detail || "adapter not ready"}`);
    }

    if ((device.clock?.sampleCount ?? 0) < CLOCK_MIN_SAMPLES) {
      warnings.push(`${device.deviceName}: clock still syncing - wait a moment before starting for tight timing.`);
    }

    if ((device.clock?.rttMs ?? 0) >= 180) {
      warnings.push(`${device.deviceName}: high clock round trip (${Math.round(device.clock.rttMs)} ms)`);
    }

    if ((device.clock?.jitterMs ?? 0) >= 35) {
      warnings.push(`${device.deviceName}: high clock jitter (${Math.round(device.clock.jitterMs)} ms)`);
    }

    if (device.status?.lastCommand?.status === "failed") {
      warnings.push(`${device.deviceName}: ${device.status.lastCommand.detail || "last command failed"}`);
    }
  }

  return [...new Set(warnings)];
}

// --- Formatting -----------------------------------------------------------

export function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// Parse a manually entered duration into milliseconds. Accepts colon notation
// ("mm:ss" or "h:mm:ss") or a bare number of seconds, and reuses
// sanitizeDurationMs for range validation. Returns undefined for blank or
// invalid input so callers can simply omit the duration.
export function parseDurationInput(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = String(value).trim();
  if (!text) {
    return undefined;
  }

  if (text.includes(":")) {
    const parts = text.split(":");
    if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
      return undefined;
    }

    const numbers = parts.map(Number);
    while (numbers.length < 3) {
      numbers.unshift(0);
    }

    const [hours, minutes, seconds] = numbers;
    if (minutes > 59 || seconds > 59) {
      return undefined;
    }

    return sanitizeDurationMs((hours * 3600 + minutes * 60 + seconds) * 1000);
  }

  if (!/^\d+$/.test(text)) {
    return undefined;
  }

  return sanitizeDurationMs(Number(text) * 1000);
}

export function formatMs(value) {
  if (value === undefined) {
    return "--";
  }

  return `${Math.round(value)} ms`;
}

export function formatSignedMs(value) {
  if (value === undefined) {
    return "--";
  }

  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded} ms`;
}

export function formatSongSource(sourceType) {
  if (sourceType === "songsterr") return "Songsterr";
  if (sourceType === "musescore") return "MuseScore";
  return "Other";
}

export function formatSongMeta(song, index, total) {
  const position = index && total ? `${index} / ${total}` : "setlist";
  const source = formatSongSource(song.sourceType);
  const references = [];
  if (song.source) references.push(song.source);
  if (song.songsterrUrl) references.push(`Songsterr: ${song.songsterrUrl}`);
  if (song.songsterrBassUrl) references.push(`Bass: ${song.songsterrBassUrl}`);
  if (song.songsterrDrumUrl) references.push(`Drums: ${song.songsterrDrumUrl}`);
  if (song.museScoreSource) references.push(`MuseScore: ${song.museScoreSource}`);
  const reference = references.length ? ` - ${references.join(" | ")}` : "";
  const duration = song.durationMs
    ? ` - ${formatElapsed(song.durationMs)} ${song.durationSource === "adapter" ? "(adapter)" : ""}`.trimEnd()
    : "";
  const helix = formatHelixMeta(song);
  return `${position} - ${source}${duration}${helix}${reference}`;
}

export function formatHelixMeta(song) {
  if (!song?.helixSyncEnabled) {
    return "";
  }

  const bpm = sanitizeHelixBpm(song.helixBpm);
  const beatsPerMeasure = sanitizeHelixBeatsPerMeasure(song.helixBeatsPerMeasure);
  const targetMeasure = sanitizeHelixTargetMeasure(song.helixTargetMeasure);
  if (!bpm || !beatsPerMeasure || !targetMeasure) {
    return " - Helix: needs BPM";
  }

  const offsetMs = clampHelixOffsetMs(song.helixOffsetMs);
  const offset = offsetMs ? `, ${formatSignedMs(offsetMs)}` : "";
  return ` - Helix: ${bpm} BPM, ${beatsPerMeasure}/4, ${targetMeasure}-measure count-in${offset}`;
}
