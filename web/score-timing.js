// Pure timing logic of the score view: where the cursor stands at a given room
// time. Kept free of the DOM so it can be unit tested (score-timing.test.ts)
// and type-checked like host-logic.js.
//
// The cursor needs no synchronisation of its own. The companion already knows
// room time (Date.now() + its measured clock offset), the room tells everyone
// the downbeat, and the exported timing map says when every note sounds. So:
//
//   songMs = startOffset + (roomNow - downbeat) * tempoPercent / 100
//
// and the cursor is wherever the timing map puts songMs. Because it is computed
// from room time on every frame rather than counted up, a throttled background
// tab or a Wi-Fi hiccup can never make it drift: it lands on the right note the
// moment the page draws again.

/**
 * @typedef {import("../src/shared/protocol.js").ScoreTiming} ScoreTiming
 * @typedef {import("../src/shared/protocol.js").ScoreTimingEvent} ScoreTimingEvent
 * @typedef {import("../src/shared/protocol.js").ScoreTimingMeasure} ScoreTimingMeasure
 * @typedef {import("../src/shared/protocol.js").ScoreManifestPart} ScoreManifestPart
 * @typedef {import("../src/shared/protocol.js").TransportState} TransportState
 */

/**
 * Where a start measure begins in song time. BandCue's measure numbers count
 * the score's measures from 1, pickup included -- the same numbering the
 * MuseScore Bridge plugin seeks by -- so measure N is the timing map's measure
 * index N - 1. A measure that is played more than once (inside a repeat) starts
 * at its first pass, which is also where MuseScore starts playing it.
 *
 * @param {ScoreTiming | undefined} timing
 * @param {number | undefined} startMeasure
 * @returns {number}
 */
export function startOffsetMs(timing, startMeasure) {
  if (!timing || !startMeasure || startMeasure <= 1) {
    return 0;
  }
  const index = Math.round(startMeasure) - 1;
  const pass = timing.events.find((event) => event.m === index);
  if (pass) {
    return pass.t;
  }
  // Past the end of the score: MuseScore lands on its last measure.
  const last = timing.events.reduce(
    (best, event) => (best === undefined || event.m > best.m ? event : best),
    /** @type {ScoreTimingEvent | undefined} */ (undefined)
  );
  return last && index > last.m ? last.t : 0;
}

/**
 * @param {{ roomNowMs: number, downbeatServerTime: number, startOffsetMs: number, tempoPercent?: number, leadMs?: number }} input
 * @returns {number} song time in ms at 100 % tempo
 */
export function songTimeMs({ roomNowMs, downbeatServerTime, startOffsetMs: offset, tempoPercent, leadMs = 0 }) {
  const rate = normalizedTempo(tempoPercent) / 100;
  return offset + (roomNowMs + leadMs - downbeatServerTime) * rate;
}

/** @param {number | undefined} tempoPercent */
export function normalizedTempo(tempoPercent) {
  return Number.isFinite(tempoPercent) && /** @type {number} */ (tempoPercent) > 0 ? /** @type {number} */ (tempoPercent) : 100;
}

/**
 * Index of the measure pass playing at songMs: the last one that has started.
 * Binary search; -1 before the first.
 *
 * @param {ScoreTimingEvent[]} events
 * @param {number} songMs
 */
export function findPassIndex(events, songMs) {
  let low = 0;
  let high = events.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (events[middle].t <= songMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * The cursor at songMs: which pass and measure, and the x position on that
 * measure's page.
 *
 * `motion` decides how it crosses a measure:
 * - `even` (default): at one steady speed from the measure's first note to
 *   where the next measure begins. Engraving spaces short notes wider than
 *   their share of the time, so following the notes would make the cursor
 *   sprint through a 16th-note run and crawl over a half note; a steady
 *   cursor is easier to read along with. It is still exact on every bar.
 * - `notes`: glides from note to note and stands on each one exactly when it
 *   sounds, speeding up and slowing down with the engraving.
 *
 * @param {ScoreTiming} timing
 * @param {number} songMs
 * @param {{ motion?: "even" | "notes" }} [options]
 * @returns {{ passIndex: number, measureIndex: number, page: number, x: number, measure: ScoreTimingMeasure, passNumber: number } | undefined}
 */
export function cursorAt(timing, songMs, { motion = "even" } = {}) {
  const events = timing.events;
  if (!events.length) {
    return undefined;
  }
  const clamped = Math.min(Math.max(songMs, events[0].t), timing.durationMs);
  const passIndex = Math.max(0, findPassIndex(events, clamped));
  const pass = events[passIndex];
  const measure = timing.measures[pass.m];
  if (!measure) {
    return undefined;
  }
  return {
    passIndex,
    measureIndex: pass.m,
    page: measure.page,
    x: anchorX(motion === "notes" || pass.b.length < 3 ? pass.b : [pass.b[0], pass.b[pass.b.length - 1]], clamped),
    measure,
    passNumber: passNumberOf(events, passIndex)
  };
}

/**
 * @param {[number, number][]} anchors
 * @param {number} songMs
 */
export function anchorX(anchors, songMs) {
  if (!anchors.length) {
    return 0;
  }
  if (songMs <= anchors[0][0]) {
    return anchors[0][1];
  }
  for (let index = 1; index < anchors.length; index += 1) {
    const [time, x] = anchors[index];
    if (songMs < time) {
      const [previousTime, previousX] = anchors[index - 1];
      const span = time - previousTime;
      return span > 0 ? previousX + (x - previousX) * ((songMs - previousTime) / span) : x;
    }
  }
  return anchors[anchors.length - 1][1];
}

/**
 * How many times this measure has been played so far, this pass included --
 * "2" on the way through a repeat the second time.
 *
 * @param {ScoreTimingEvent[]} events
 * @param {number} passIndex
 */
export function passNumberOf(events, passIndex) {
  const measure = events[passIndex]?.m;
  let count = 0;
  for (let index = 0; index <= passIndex; index += 1) {
    if (events[index].m === measure) {
      count += 1;
    }
  }
  return count;
}

/**
 * What the transport means for the cursor right now.
 *
 * - `idle`: nothing played yet for this song; the cursor waits on the start measure.
 * - `countdown`: a Play is scheduled; the cursor waits on the start measure.
 * - `running`: the cursor moves.
 * - `stopped`: a Play of this song ended; the cursor stays where it stopped.
 *
 * `lastPlay` is the caller's memory of the latest Play it saw for the current
 * song: the stopped room state alone no longer says where playback began.
 *
 * @param {TransportState | undefined} transport
 * @param {{ sequenceId: number, downbeatServerTime: number } | undefined} lastPlay
 * @param {number} roomNowMs
 * @returns {{ mode: "idle" | "countdown" | "running" | "stopped", downbeatServerTime?: number, stoppedAtServerTime?: number, remainingMs?: number }}
 */
export function resolvePlayhead(transport, lastPlay, roomNowMs) {
  if (transport && transport.action === "play" && (transport.status === "scheduled" || transport.status === "running")) {
    const downbeat = transport.status === "running"
      ? transport.startedServerTime ?? transport.scheduledServerTime
      : transport.scheduledServerTime;
    if (downbeat === undefined) {
      return { mode: "idle" };
    }
    return roomNowMs < downbeat
      ? { mode: "countdown", downbeatServerTime: downbeat, remainingMs: downbeat - roomNowMs }
      : { mode: "running", downbeatServerTime: downbeat };
  }
  if (transport?.status === "stopped" && lastPlay && transport.sequenceId > lastPlay.sequenceId) {
    return {
      mode: "stopped",
      downbeatServerTime: lastPlay.downbeatServerTime,
      stoppedAtServerTime: transport.scheduledServerTime ?? roomNowMs
    };
  }
  return { mode: "idle" };
}

/**
 * The lines of music ("systems") of a part, in reading order, and which line
 * every measure is on. Scrolling follows lines, not measures.
 *
 * @param {ScoreTiming} timing
 * @returns {{ systems: { page: number, top: number, bottom: number }[], systemOfMeasure: number[] }}
 */
export function systemsOf(timing) {
  /** @type {{ page: number, top: number, bottom: number }[]} */
  const systems = [];
  /** @type {number[]} */
  const systemOfMeasure = [];
  timing.measures.forEach((measure, index) => {
    if (!measure) {
      systemOfMeasure[index] = Math.max(0, systems.length - 1);
      return;
    }
    const last = systems[systems.length - 1];
    if (last && last.page === measure.page && Math.abs(last.top - measure.y) < 1) {
      last.bottom = Math.max(last.bottom, measure.y + measure.h);
    } else {
      systems.push({ page: measure.page, top: measure.y, bottom: measure.y + measure.h });
    }
    systemOfMeasure[index] = systems.length - 1;
  });
  return { systems, systemOfMeasure };
}

// Instrument families for carrying a player's part choice from song to song:
// a drummer who picked "Schlagzeug" in one score wants "Drums" in the next.
const PART_FAMILIES = [
  ["drums", /drum|schlag|perc|batter|kit\b/i],
  ["bass", /bass/i],
  ["guitar", /guit|gitar/i],
  ["vocals", /voc|voice|stimme|gesang|sing|lead vox/i],
  ["keys", /key|piano|klavier|synth|organ|orgel/i]
];

/** @param {string} name */
export function partFamily(name) {
  // "Bass Drum" is a drum part, so drums are checked before bass.
  for (const [family, pattern] of PART_FAMILIES) {
    if (/** @type {RegExp} */ (pattern).test(name)) {
      return /** @type {string} */ (family);
    }
  }
  return "";
}

/**
 * Picks the part to show: the one the player chose by name, else one of the
 * same instrument family, else the full score.
 *
 * Guitar and bass come as notes and as tab; `notation` picks between them.
 *
 * @param {Pick<ScoreManifestPart, "id" | "name" | "instrument" | "notation">[]} parts
 * @param {string | undefined} preferredName
 * @param {"notes" | "tab"} [notation]
 * @returns {string | undefined} part id
 */
export function choosePart(parts, preferredName, notation = "tab") {
  if (!parts.length) {
    return undefined;
  }
  const wanted = String(preferredName ?? "").trim().toLowerCase();
  let pick = parts.find((part) => part.id === "score") ?? parts[0];
  if (wanted) {
    const exact = parts.find((part) => part.name.trim().toLowerCase() === wanted);
    const family = partFamily(wanted);
    const sameFamily = family ? parts.find((part) => part.id !== "score" && partFamily(part.name) === family) : undefined;
    pick = exact ?? sameFamily ?? pick;
  }
  return partInNotation(parts, pick.instrument ?? pick.id, notation) ?? pick.id;
}

/**
 * The instruments a score offers, in order, each with the notations it comes in.
 *
 * @param {Pick<ScoreManifestPart, "id" | "name" | "instrument" | "notation">[]} parts
 * @returns {{ key: string, name: string, notations: ("notes" | "tab")[] }[]}
 */
export function instrumentsOf(parts) {
  /** @type {{ key: string, name: string, notations: ("notes" | "tab")[] }[]} */
  const instruments = [];
  for (const part of parts) {
    const key = part.instrument ?? part.id;
    let instrument = instruments.find((candidate) => candidate.key === key);
    if (!instrument) {
      instrument = { key, name: part.name, notations: [] };
      instruments.push(instrument);
    }
    if (part.notation) {
      instrument.notations.push(part.notation);
    }
  }
  return instruments;
}

/**
 * @param {Pick<ScoreManifestPart, "id" | "instrument" | "notation">[]} parts
 * @param {string} instrument
 * @param {"notes" | "tab"} notation
 * @returns {string | undefined}
 */
export function partInNotation(parts, instrument, notation) {
  const voices = parts.filter((part) => (part.instrument ?? part.id) === instrument);
  return (voices.find((part) => part.notation === notation) ?? voices[0])?.id;
}

/**
 * Pages to show in page mode: the cursor's page, and the next one beside it.
 * With two slots, even pages sit left and odd pages right, so once the cursor
 * reaches the right-hand page the left one already turns to the page after:
 * the next page is always in view (a half-page turn, as on a music stand).
 *
 * @param {number} page current page index
 * @param {number} pageCount
 * @param {1 | 2} slots
 * @returns {number[]} page indices, in left-to-right order
 */
export function visiblePages(page, pageCount, slots) {
  if (pageCount <= 0) {
    return [];
  }
  const current = Math.min(Math.max(0, page), pageCount - 1);
  if (slots === 1 || pageCount === 1) {
    return [current];
  }
  const next = current + 1 < pageCount ? current + 1 : current - 1;
  return [current, next].sort((left, right) => (left % 2) - (right % 2) || left - right);
}

/**
 * Where to scroll so the cursor's line sits on the reading line and the lines
 * after it fill the rest of the view -- the read-ahead buffer. All values in
 * CSS pixels of the scroll container's content.
 *
 * @param {{ lineTop: number, lineBottom: number, nextBottom?: number, viewportHeight: number, readingLine: number }} input
 *   readingLine: 0 (top) to 1, where the current line's top should sit.
 */
export function followScrollTop({ lineTop, lineBottom, nextBottom, viewportHeight, readingLine }) {
  const margin = Math.min(24, viewportHeight * 0.04);
  let target = lineTop - viewportHeight * readingLine;
  // Never let the line after the current one hang off the bottom just to keep
  // the reading line: move the current line up as far as needed (but not off
  // the top).
  const mustSeeBottom = nextBottom ?? lineBottom;
  if (mustSeeBottom - target > viewportHeight - margin) {
    target = Math.min(lineTop - margin, mustSeeBottom - viewportHeight + margin);
  }
  return Math.max(0, target);
}
