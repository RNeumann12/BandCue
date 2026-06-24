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
    songsterrBassUrl: song.songsterrBassUrl || undefined,
    songsterrDrumUrl: song.songsterrDrumUrl || undefined,
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
    songsterrBassUrl: typeof song.songsterrBassUrl === "string" ? song.songsterrBassUrl.trim() : "",
    songsterrDrumUrl: typeof song.songsterrDrumUrl === "string" ? song.songsterrDrumUrl.trim() : "",
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
  return `${position} - ${source}${duration}${reference}`;
}
