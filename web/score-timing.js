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

/** How the cursor moves; see cursorAt. */
export const CURSOR_STYLES = /** @type {const} */ (["beats", "step", "even", "notes", "bar"]);
/** @typedef {typeof CURSOR_STYLES[number]} CursorStyle */

/** How long the `step` cursor takes to slide to the next beat. */
export const STEP_EASE_MS = 60;

/**
 * The cursor at songMs: which pass and measure, the x position on that
 * measure's page, and which beat of the measure it is on.
 *
 * `motion` decides how it crosses a measure:
 * - `beats` (default): at a steady speed within each beat, from where one beat
 *   is engraved to where the next is -- exactly on every beat, like a beat
 *   cursor that glides (alphaTab's animated beat cursor). Steady enough to read
 *   along with, and never off the beat the band is on.
 * - `step`: stands on each beat and moves on to the next one on the beat, in a
 *   quick slide (STEP_EASE_MS): a metronome on the page.
 * - `even`: at one steady speed from the measure's first note to where the next
 *   measure begins. Engraving spaces short notes wider than their share of the
 *   time, so following the notes would make the cursor sprint through a
 *   16th-note run and crawl over a half note. It is exact on every bar only.
 * - `notes`: glides from note to note and stands on each one exactly when it
 *   sounds, speeding up and slowing down with the engraving.
 * - `bar`: like `step`; the view shows the bar and its beats instead of a line.
 *
 * @param {ScoreTiming} timing
 * @param {number} songMs
 * @param {{ motion?: CursorStyle }} [options]
 * @returns {{ passIndex: number, measureIndex: number, page: number, x: number, measure: ScoreTimingMeasure, passNumber: number, beat: { index: number, count: number, startMs: number, endMs: number } } | undefined}
 */
export function cursorAt(timing, songMs, { motion = "beats" } = {}) {
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
  const beats = beatsOf(timing, passIndex);
  let beatIndex = 0;
  while (beatIndex + 1 < beats.length && beats[beatIndex + 1] <= clamped) {
    beatIndex += 1;
  }
  const beat = {
    index: beatIndex,
    count: beats.length,
    startMs: beats[beatIndex],
    endMs: beats[beatIndex + 1] ?? pass.e
  };
  return {
    passIndex,
    measureIndex: pass.m,
    page: measure.page,
    x: cursorX(pass, beats, beatIndex, clamped, motion),
    measure,
    passNumber: passNumberOf(events, passIndex),
    beat
  };
}

/**
 * @param {ScoreTimingEvent} pass
 * @param {number[]} beats
 * @param {number} beatIndex
 * @param {number} songMs
 * @param {CursorStyle} motion
 */
function cursorX(pass, beats, beatIndex, songMs, motion) {
  if (motion === "notes" || pass.b.length < 2) {
    return anchorX(pass.b, songMs);
  }
  if (motion === "even") {
    return anchorX(pass.b.length < 3 ? pass.b : [pass.b[0], pass.b[pass.b.length - 1]], songMs);
  }
  // Where each beat is engraved: between the notes around it.
  const beatAnchors = beats.map((time) => /** @type {[number, number]} */ ([time, anchorX(pass.b, time)]));
  beatAnchors.push(pass.b[pass.b.length - 1]);
  if (motion === "beats") {
    return anchorX(beatAnchors, songMs);
  }
  // step / bar: on the beat, with a short slide from the beat before (none
  // onto a new bar: that may be a new line).
  const target = beatAnchors[beatIndex][1];
  if (beatIndex === 0) {
    return target;
  }
  const from = beatAnchors[beatIndex - 1][1];
  const progress = Math.min(1, Math.max(0, (songMs - beats[beatIndex]) / STEP_EASE_MS));
  return from + (target - from) * (1 - (1 - progress) ** 3);
}

/**
 * The time signature of a measure; 4/4 when the export says nothing.
 *
 * @param {ScoreTiming} timing
 * @param {number} measureIndex
 * @returns {{ n: number, d: number }}
 */
export function meterAt(timing, measureIndex) {
  let meter = { n: 4, d: 4 };
  for (const candidate of timing.meters ?? []) {
    if (candidate.m > measureIndex) {
      break;
    }
    meter = candidate;
  }
  return meter;
}

/**
 * Beats of a time signature: compound time (6/8, 9/8, 12/8) counts dotted
 * quarters, everything else its own unit.
 *
 * @param {{ n: number, d: number }} meter
 */
export function beatsPerMeasure(meter) {
  return meter.d === 8 && meter.n > 3 && meter.n % 3 === 0 ? meter.n / 3 : Math.max(1, meter.n);
}

/**
 * When each beat of a measure pass starts, in song ms (the first is the
 * pass's start). A pass shorter than its time signature -- a pickup, a bar
 * cut short -- is counted with the beat of a full neighbouring pass of the
 * same meter.
 *
 * @param {ScoreTiming} timing
 * @param {number} passIndex
 * @returns {number[]}
 */
export function beatsOf(timing, passIndex) {
  const events = timing.events;
  const pass = events[passIndex];
  if (!pass) {
    return [];
  }
  const meter = meterAt(timing, pass.m);
  const count = beatsPerMeasure(meter);
  const length = pass.e - pass.t;
  if (!(length > 0)) {
    return [pass.t];
  }
  let beatMs = length / count;
  for (const neighbour of [events[passIndex + 1], events[passIndex - 1]]) {
    if (!neighbour) {
      continue;
    }
    const other = meterAt(timing, neighbour.m);
    const otherMs = (neighbour.e - neighbour.t) / beatsPerMeasure(other);
    if (other.n === meter.n && other.d === meter.d && otherMs > beatMs * 1.15) {
      beatMs = otherMs;
    }
    break;
  }
  const beats = Math.max(1, Math.min(count, Math.round(length / beatMs)));
  return Array.from({ length: beats }, (_, index) => pass.t + (length / beats) * index);
}

/**
 * The beat nearest to songMs, in song ms -- what a tap along with the band was
 * meant to hit.
 *
 * @param {ScoreTiming} timing
 * @param {number} songMs
 * @returns {number | undefined}
 */
export function nearestBeatMs(timing, songMs) {
  const passIndex = findPassIndex(timing.events, songMs);
  if (passIndex < 0) {
    return timing.events[0]?.t;
  }
  let best;
  for (const index of [passIndex - 1, passIndex, passIndex + 1]) {
    const beats = timing.events[index] ? [...beatsOf(timing, index), timing.events[index].e] : [];
    for (const beat of beats) {
      if (best === undefined || Math.abs(beat - songMs) < Math.abs(best - songMs)) {
        best = beat;
      }
    }
  }
  return best;
}

// People tapping along with a beat tap slightly early, by about this much
// ("negative mean asynchrony", typically 20-50 ms).
export const TAP_ANTICIPATION_MS = 30;

/**
 * The cursor lead that puts the cursor on the beat this player hears, from
 * how far their taps landed after the beats the cursor showed (room ms, lead
 * 0). The median, so a missed tap does not count.
 *
 * @param {number[]} tapErrorsMs
 * @returns {number | undefined}
 */
export function leadFromTaps(tapErrorsMs) {
  if (tapErrorsMs.length < 4) {
    return undefined;
  }
  const sorted = [...tapErrorsMs].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const lead = -Math.round((median + TAP_ANTICIPATION_MS) / 5) * 5;
  return Math.max(-500, Math.min(1000, lead)) || 0;
}

/**
 * Room time that moves as smoothly as the display: read from the monotonic
 * performance clock and pulled toward the synced room clock over ~200 ms, so a
 * clock-sync correction or a coarse Date.now() never makes the cursor twitch.
 * A jump of more than 250 ms (a resync after sleep) is taken at once.
 *
 * @param {() => number | undefined} read the synced room clock
 * @param {() => number} [perfNow]
 * @returns {() => number | undefined}
 */
export function createSteadyClock(read, perfNow = () => performance.now()) {
  /** @type {{ room: number, perf: number } | undefined} */
  let last;
  return () => {
    const raw = read();
    if (raw === undefined) {
      last = undefined;
      return undefined;
    }
    const perf = perfNow();
    if (!last) {
      last = { room: raw, perf };
      return raw;
    }
    const predicted = last.room + (perf - last.perf);
    const error = raw - predicted;
    const room = Math.abs(error) > 250 ? raw : predicted + error * Math.min(1, (perf - last.perf) / 200);
    last = { room, perf };
    return room;
  };
}

/** Bars compared when lining a Songsterr import up with the band's score. */
const ALIGN_BARS = 32;

/**
 * How many bars a Songsterr import lacks at its start compared with the band's
 * own score (the band writes a count-in bar into every song): the shift k
 * where the band's pass i + k is the import's pass i.
 *
 * The evidence is where the two disagree bar by bar: a time signature, or a
 * bar whose length breaks the ratio between the two scores' tempos (a tempo
 * change, a 2/4 bar). The shift with the fewest disagreements wins. Where the
 * music gives none (one tempo, one meter throughout), the band's empty bars
 * before the first note decide -- that is the count-in. The scores' lengths
 * prove nothing: they often differ at the end too. Only the first ALIGN_BARS
 * bars are compared: arrangements drift apart later (an extra chorus), and
 * that says nothing about the start.
 *
 * @param {ScoreTiming} reference the band's MuseScore score
 * @param {ScoreTiming} imported
 * @returns {number}
 */
export function detectBarOffset(reference, imported) {
  const ours = reference.events;
  const theirs = imported.events;
  let countIn = 0;
  while (countIn < ours.length && ours[countIn].b.length <= 2) {
    countIn += 1;
  }
  const prior = countIn >= 1 && countIn <= 4 ? countIn : 1;
  const lengthOf = (/** @type {ScoreTimingEvent} */ pass) => pass.e - pass.t;
  const ratios = theirs.slice(0, ours.length).map((pass, index) => lengthOf(ours[index]) / lengthOf(pass)).filter(Number.isFinite);
  const tempoRatio = ratios.length ? [...ratios].sort((left, right) => left - right)[ratios.length >> 1] : 1;

  // Every shift is judged on the same number of bars.
  const bars = Math.max(0, Math.min(ALIGN_BARS, theirs.length, ours.length - 4));
  const shifts = [prior, 0, 1, 2, 3, 4];
  const onsets = (/** @type {ScoreTimingEvent} */ pass) => pass.b.length - 2;
  /** @param {number} shift */
  const onsetMatches = (shift) => {
    let matches = 0;
    for (let index = 0; index < bars; index += 1) {
      matches += onsets(ours[index + shift]) === onsets(theirs[index]) ? 1 : 0;
    }
    return matches;
  };
  // How many notes start in each bar says where the music is -- but only when
  // both scores hold the same parts (a cover), not the band's full score
  // against a drum-only tab.
  const useOnsets = bars > 0 && Math.max(...shifts.map(onsetMatches)) >= bars * 0.6;

  let best = prior;
  let fewest = Infinity;
  for (const shift of shifts) {
    let disagreements = useOnsets ? bars - onsetMatches(shift) : 0;
    for (let index = 0; index < bars; index += 1) {
      const band = ours[index + shift];
      const songsterr = theirs[index];
      const bandMeter = meterAt(reference, band.m);
      const songsterrMeter = meterAt(imported, songsterr.m);
      const ratio = lengthOf(band) / lengthOf(songsterr) / tempoRatio;
      disagreements += bandMeter.n !== songsterrMeter.n || bandMeter.d !== songsterrMeter.d ? 3 : 0;
      disagreements += Math.abs(ratio - 1) < 0.04 ? 0 : 1;
    }
    if (disagreements < fewest) {
      best = shift;
      fewest = disagreements;
    }
  }
  return best;
}

/**
 * The import's song time for the band's song time: bar by bar, so the cursor
 * on a Songsterr score stays on the bar the band plays even where Songsterr's
 * tempo differs from the band's. The band's pass p is the import's pass
 * p - shift, at the same fraction of the bar; before that (the count-in) the
 * import waits on its start.
 *
 * @param {ScoreTiming} reference
 * @param {ScoreTiming} imported
 * @param {number} referenceMs
 * @param {number} shift see detectBarOffset
 */
export function importedSongMs(reference, imported, referenceMs, shift) {
  const events = imported.events;
  if (!events.length) {
    return referenceMs;
  }
  const passIndex = findPassIndex(reference.events, referenceMs);
  const ours = reference.events[passIndex];
  const index = passIndex - shift;
  if (!ours || index < 0) {
    return events[0].t;
  }
  const theirs = events[index];
  if (!theirs) {
    return imported.durationMs;
  }
  const length = ours.e - ours.t;
  const fraction = length > 0 ? Math.min(1, Math.max(0, (referenceMs - ours.t) / length)) : 0;
  return theirs.t + fraction * (theirs.e - theirs.t);
}

/**
 * The band's measure (0-based) for a measure of the import, for "tap a bar to
 * start there" on a Songsterr score: its first pass, shifted. Undefined for a
 * measure the band's score does not have.
 *
 * @param {ScoreTiming} reference
 * @param {ScoreTiming} imported
 * @param {number} importedMeasureIndex
 * @param {number} shift
 */
export function referenceMeasureOf(reference, imported, importedMeasureIndex, shift) {
  const index = imported.events.findIndex((pass) => pass.m === importedMeasureIndex);
  return index < 0 ? undefined : reference.events[index + shift]?.m;
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
