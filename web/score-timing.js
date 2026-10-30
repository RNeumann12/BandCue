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
 * @typedef {import("../src/shared/protocol.js").ScoreAvailability} ScoreAvailability
 * @typedef {import("../src/shared/protocol.js").TransportState} TransportState
 * @typedef {import("../src/shared/protocol.js").ScoreTimingSection} ScoreTimingSection
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
 * - `elsewhere`: the room is playing another song (the host moved on while it
 *   ran); this song's cursor waits on its start measure.
 *
 * `lastPlay` is the caller's memory of the latest Play it saw for the current
 * song (see playOfSong): the stopped room state alone no longer says where
 * playback began.
 *
 * @param {TransportState | undefined} transport
 * @param {PlayOfSong | undefined} lastPlay
 * @param {number} roomNowMs
 * @param {string} [songId] the current song; a play of another song is `elsewhere`
 * @returns {{ mode: "idle" | "countdown" | "running" | "stopped" | "elsewhere", downbeatServerTime?: number, stoppedAtServerTime?: number, remainingMs?: number, play?: PlayOfSong }}
 */
export function resolvePlayhead(transport, lastPlay, roomNowMs, songId) {
  if (transport && transport.action === "play" && (transport.status === "scheduled" || transport.status === "running")) {
    const play = playOfSong(transport, songId);
    if (!play) {
      return transport.song && songId !== undefined && transport.song.id !== songId ? { mode: "elsewhere" } : { mode: "idle" };
    }
    return roomNowMs < play.downbeatServerTime
      ? { mode: "countdown", downbeatServerTime: play.downbeatServerTime, remainingMs: play.downbeatServerTime - roomNowMs, play }
      : { mode: "running", downbeatServerTime: play.downbeatServerTime, play };
  }
  if (transport?.status === "stopped" && lastPlay && transport.sequenceId > lastPlay.sequenceId) {
    return {
      mode: "stopped",
      downbeatServerTime: lastPlay.downbeatServerTime,
      stoppedAtServerTime: transport.scheduledServerTime ?? roomNowMs,
      play: lastPlay
    };
  }
  return { mode: "idle" };
}

/**
 * @typedef {{ sequenceId: number, downbeatServerTime: number, startMeasure?: number, tempoPercent?: number }} PlayOfSong
 */

/**
 * The Play the transport describes, if it is a play of `songId`: its downbeat
 * and the start measure and tempo it was started with. A transport without a
 * song (an older coordinator) counts as the current song's.
 *
 * @param {TransportState | undefined} transport
 * @param {string | undefined} songId
 * @returns {PlayOfSong | undefined}
 */
export function playOfSong(transport, songId) {
  if (!transport || transport.action !== "play" || (transport.status !== "scheduled" && transport.status !== "running")) {
    return undefined;
  }
  if (transport.song && songId !== undefined && transport.song.id !== songId) {
    return undefined;
  }
  const downbeat = transport.status === "running"
    ? transport.startedServerTime ?? transport.scheduledServerTime
    : transport.scheduledServerTime;
  if (downbeat === undefined) {
    return undefined;
  }
  return {
    sequenceId: transport.sequenceId,
    downbeatServerTime: downbeat,
    ...(transport.song ? { startMeasure: transport.song.startMeasure, tempoPercent: transport.song.tempoPercent } : {})
  };
}

/**
 * The rehearsal mark the measure belongs to ("Chorus"), if the score has any.
 *
 * @param {ScoreTiming} timing
 * @param {number} measureIndex
 * @returns {string | undefined}
 */
export function sectionAt(timing, measureIndex) {
  let label;
  for (const section of timing.sections ?? []) {
    if (section.m > measureIndex) {
      break;
    }
    label = section.label;
  }
  return label;
}

/**
 * Where playback goes after this pass when it does not simply carry on with
 * the next measure: back for a repeat, or a jump (volta, D.S., Coda).
 *
 * @param {ScoreTimingEvent[]} events
 * @param {number} passIndex
 * @returns {{ kind: "repeat" | "jump", toMeasureIndex: number } | undefined}
 */
export function jumpAfter(events, passIndex) {
  const pass = events[passIndex];
  const next = events[passIndex + 1];
  if (!pass || !next || next.m === pass.m + 1) {
    return undefined;
  }
  return { kind: next.m <= pass.m ? "repeat" : "jump", toMeasureIndex: next.m };
}

/**
 * The beat a count-in counts in, in room milliseconds: the start measure's
 * length divided by its time signature's beats, stretched by the tempo. A
 * pickup measure is shorter than its time signature, so the measure after it
 * is measured instead. Undefined when the export says nothing about meters.
 *
 * @param {ScoreTiming} timing
 * @param {number | undefined} startMeasure
 * @param {number | undefined} tempoPercent
 * @returns {{ beatMs: number, beatsPerMeasure: number } | undefined}
 */
export function countInBeat(timing, startMeasure, tempoPercent) {
  if (!timing.meters?.length || !timing.events.length) {
    return undefined;
  }
  const index = Math.max(0, Math.round(startMeasure ?? 1) - 1);
  let passIndex = Math.max(0, timing.events.findIndex((event) => event.m === index));
  if (timing.events[passIndex].m === 0 && timing.events.length > passIndex + 1) {
    passIndex += 1;
  }
  const pass = timing.events[passIndex];
  let meter = timing.meters[0];
  for (const candidate of timing.meters) {
    if (candidate.m > pass.m) {
      break;
    }
    meter = candidate;
  }
  const measureMs = pass.e - pass.t;
  if (!(measureMs > 0) || !(meter.n > 0)) {
    return undefined;
  }
  return { beatMs: (measureMs / meter.n) * 100 / normalizedTempo(tempoPercent), beatsPerMeasure: meter.n };
}

/**
 * The count-in as beats: how many are left before the downbeat (the number to
 * show) and how far into the current beat it is (0..1, for a flash on the beat).
 * Only the last two measures are counted in beats; longer waits show seconds.
 *
 * @param {number} remainingMs
 * @param {{ beatMs: number, beatsPerMeasure: number } | undefined} beat
 * @returns {{ beatsLeft: number, phase: number } | undefined}
 */
export function countInState(remainingMs, beat) {
  if (!beat || remainingMs <= 0 || remainingMs > beat.beatMs * beat.beatsPerMeasure * 2) {
    return undefined;
  }
  const beatsLeft = Math.ceil(remainingMs / beat.beatMs - 1e-6);
  const phase = 1 - (remainingMs / beat.beatMs - (beatsLeft - 1));
  return { beatsLeft, phase: Math.min(1, Math.max(0, phase)) };
}

/**
 * The measure under a point of a page, in that page's SVG units -- for the
 * host's "tap a bar to start there".
 *
 * @param {ScoreTiming} timing
 * @param {number} page
 * @param {number} x
 * @param {number} y
 * @returns {number | undefined} measure index (0-based)
 */
export function measureAtPoint(timing, page, x, y) {
  /** @type {number | undefined} */
  let best;
  let bestDistance = Infinity;
  timing.measures.forEach((measure, index) => {
    if (!measure || measure.page !== page || x < measure.x || x > measure.x + measure.w) {
      return;
    }
    // Inside the box, or the nearest system above or below (a tap between
    // staves, on a chord symbol or a lyric still means that measure).
    const distance = y < measure.y ? measure.y - y : y > measure.y + measure.h ? y - measure.y - measure.h : 0;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return bestDistance <= 400 ? best : undefined;
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
 * Which export of a song this device reads: the band's MuseScore score, or a
 * score imported from Songsterr. With `source` "songsterr" it takes the import
 * of the Songsterr page that serves this player's instrument (a drummer's
 * arrangement may be a different Songsterr song than the main tab), else the
 * main tab's. Either way it falls back to whatever is ready.
 *
 * @param {ScoreAvailability | undefined} score
 * @param {string | undefined} preferredPart
 * @param {"musescore" | "songsterr"} source
 * @returns {{ scoreId: string, origin: "musescore" | "songsterr", revision?: string } | undefined}
 */
export function resolveScoreSource(score, preferredPart, source) {
  if (!score) {
    return undefined;
  }
  const imports = (score.imports ?? []).filter((entry) => entry.status === "ready" && entry.scoreId);
  const family = partFamily(String(preferredPart ?? ""));
  const role = family === "drums" || family === "bass" ? family : "main";
  const imported = imports.find((entry) => entry.roles.includes(role)) ??
    imports.find((entry) => entry.roles.includes("main")) ??
    imports[0];
  const fromImport = imported?.scoreId
    ? { scoreId: imported.scoreId, origin: /** @type {const} */ ("songsterr"), revision: imported.revision }
    : undefined;
  const local = score.status === "ready" && score.scoreId
    ? { scoreId: score.scoreId, origin: /** @type {const} */ ("musescore") }
    : undefined;
  return source === "songsterr" ? fromImport ?? local : local ?? fromImport;
}

/**
 * Picks the part to show: the one the player chose by name, else the one at
 * the same place among the instruments of its family (the second guitarist
 * reads the second guitar part, whatever it is called), else the first of that
 * family, else the full score.
 *
 * Guitar and bass come as notes and as tab; `notation` picks between them.
 *
 * @param {Pick<ScoreManifestPart, "id" | "name" | "instrument" | "notation">[]} parts
 * @param {string | undefined} preferredName
 * @param {"notes" | "tab"} [notation]
 * @param {number} [familyIndex] which of the family's instruments, 0-based
 * @returns {string | undefined} part id
 */
export function choosePart(parts, preferredName, notation = "tab", familyIndex = 0) {
  if (!parts.length) {
    return undefined;
  }
  const wanted = String(preferredName ?? "").trim().toLowerCase();
  let pick = parts.find((part) => part.id === "score") ?? parts[0];
  if (wanted) {
    const exact = parts.find((part) => part.name.trim().toLowerCase() === wanted);
    const family = partFamily(wanted);
    const relatives = family ? familyInstruments(parts, family) : [];
    const sameFamily = relatives.length
      ? relatives[Math.min(Math.max(0, Math.round(familyIndex) || 0), relatives.length - 1)]
      : undefined;
    pick = exact ?? sameFamily ?? pick;
  }
  return partInNotation(parts, pick.instrument ?? pick.id, notation) ?? pick.id;
}

/**
 * The parts of one instrument family, one per instrument, in score order.
 *
 * @template {Pick<ScoreManifestPart, "id" | "name" | "instrument">} T
 * @param {T[]} parts
 * @param {string} family
 * @returns {T[]}
 */
export function familyInstruments(parts, family) {
  /** @type {T[]} */
  const found = [];
  for (const part of parts) {
    if (part.id === "score" || partFamily(part.name) !== family) {
      continue;
    }
    if (!found.some((other) => (other.instrument ?? other.id) === (part.instrument ?? part.id))) {
      found.push(part);
    }
  }
  return found;
}

/**
 * Where a part stands among its family's instruments (0 for the first guitar).
 *
 * @param {Pick<ScoreManifestPart, "id" | "name" | "instrument">[]} parts
 * @param {string} partId
 */
export function familyIndexOf(parts, partId) {
  const part = parts.find((candidate) => candidate.id === partId);
  const family = part ? partFamily(part.name) : "";
  if (!part || !family) {
    return 0;
  }
  return Math.max(0, familyInstruments(parts, family)
    .findIndex((other) => (other.instrument ?? other.id) === (part.instrument ?? part.id)));
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
 * Pages to show in page mode.
 *
 * - `half` (default): the cursor's page and the next one beside it. With two
 *   slots, even pages sit left and odd pages right, so once the cursor reaches
 *   the right-hand page the left one already turns to the page after: the next
 *   page is always in view (a half-page turn, as on a music stand). The page
 *   after then sits left of the one being played, so every page carries its
 *   number.
 * - `whole`: an open book -- pages 1+2, then 3+4 -- always in reading order.
 *
 * @param {number} page current page index
 * @param {number} pageCount
 * @param {1 | 2} slots
 * @param {"half" | "whole"} [turn]
 * @returns {number[]} page indices, in left-to-right order
 */
export function visiblePages(page, pageCount, slots, turn = "half") {
  if (pageCount <= 0) {
    return [];
  }
  const current = Math.min(Math.max(0, page), pageCount - 1);
  if (slots === 1 || pageCount === 1) {
    return [current];
  }
  if (turn === "whole") {
    const left = current - (current % 2);
    return left + 1 < pageCount ? [left, left + 1] : [left];
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
