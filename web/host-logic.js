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
    museScoreSource: song.museScoreSource || undefined,
    durationMs: sanitizeDurationMs(song.durationMs),
    durationSource: sanitizeDurationMs(song.durationMs) ? (song.durationSource || "manual") : undefined,
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
    museScoreSource: typeof song.museScoreSource === "string" ? song.museScoreSource.trim() : "",
    durationMs: sanitizeDurationMs(song.durationMs),
    durationSource: sanitizeDurationMs(song.durationMs) ? normalizeDurationSource(song.durationSource) : undefined,
    notes: typeof song.notes === "string" ? song.notes.trim() : ""
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

// A song is openable when at least one adapter can resolve a reference for it.
export function isOpenableSong(song) {
  return Boolean(song) && (appliesToMuseScore(song) || Boolean(getSongsterrUrl(song)));
}

// --- Clock / timing math --------------------------------------------------

export function calculateClockSample(clientSentAt, clientReceivedAt, serverReceivedAt, serverSentAt) {
  const rttMs = clientReceivedAt - clientSentAt - (serverSentAt - serverReceivedAt);
  const offsetMs = (serverReceivedAt - clientSentAt + (serverSentAt - clientReceivedAt)) / 2;
  return { rttMs: Math.max(0, rttMs), offsetMs };
}

export function summarizeClock(clockSamples) {
  const best = [...clockSamples].sort((a, b) => a.rttMs - b.rttMs).slice(0, 5);
  return {
    rttMs: median(best.map((sample) => sample.rttMs)),
    offsetMs: median(best.map((sample) => sample.offsetMs))
  };
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

export function clampManualOffset(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-1000, Math.min(1000, Math.round(value)));
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
  if (song.museScoreSource) references.push(`MuseScore: ${song.museScoreSource}`);
  const reference = references.length ? ` - ${references.join(" | ")}` : "";
  const duration = song.durationMs
    ? ` - ${formatElapsed(song.durationMs)} ${song.durationSource === "adapter" ? "(adapter)" : ""}`.trimEnd()
    : "";
  return `${position} - ${source}${duration}${reference}`;
}
