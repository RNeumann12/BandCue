// Score view: the current song's notes (its MuseScore score, or a score imported
// from Songsterr) with a cursor that follows the room's downbeat, so any browser in the room (an iPad on a music stand, a
// laptop without MuseScore) can read along. It only ever reads: it never asks
// the room to play or stop, and it plays no audio. (The host may tap a bar to
// make it the song's start measure; the host page applies that.)
//
// The pages are MuseScore's own SVG export, shown as <img> -- never inlined, so
// nothing inside a file can run here. The cursor is one absolutely positioned
// element moved with a transform on every animation frame while a song runs;
// its position comes from score-timing.js, computed from room time each frame.
//
// Reading ahead, like Songsterr: in scroll mode the line being played sits near
// the top of the view (the "reading line") and the following lines fill the rest
// of it; page mode shows the next page beside the current one and turns the
// left page as soon as the cursor reaches the right one.

import {
  CURSOR_STYLES,
  choosePart,
  countInBeat,
  countInState,
  createSteadyClock,
  cursorAt,
  detectBarOffset,
  familyIndexOf,
  findPassIndex,
  followScrollTop,
  importedSongMs,
  instrumentsOf,
  jumpAfter,
  leadFromTaps,
  measureAtPoint,
  nearestBeatMs,
  normalizedTempo,
  partInNotation,
  playOfSong,
  referenceMeasureOf,
  resolvePlayhead,
  resolveScoreSource,
  sectionAt,
  songTimeMs,
  startOffsetMs,
  systemsOf,
  visiblePages
} from "./score-timing.js";
import { createKeepAwake } from "./keep-awake.js";

/**
 * @typedef {import("../src/shared/protocol.js").RoomState} RoomState
 * @typedef {import("../src/shared/protocol.js").ScoreManifest} ScoreManifest
 * @typedef {import("../src/shared/protocol.js").ScoreTiming} ScoreTiming
 * @typedef {import("../src/shared/protocol.js").ScoreAvailability} ScoreAvailability
 * @typedef {import("./score-timing.js").PlayOfSong} PlayOfSong
 */

const SETTINGS_KEY = "bandcue:score-view";
const READING_LINES = { top: 0.06, upper: 0.2, middle: 0.38 };
const FOLLOW_ANIMATION_MS = 420;
// How long a finger or wheel on the score holds off the automatic scrolling.
const FOLLOW_PAUSE_MS = 5_000;
// After a failed load, how long before that score is tried again.
const LOAD_RETRY_MS = 3_000;
// Manifests and timing maps kept in memory (a set is rarely longer).
const CACHE_LIMIT = 24;
// Songs whose part choice is remembered.
const SONG_PART_LIMIT = 200;
// Cursor size in SVG units of the page (MuseScore pages are ~9924 wide).
const CURSOR_WIDTH = 64;
const CURSOR_OVERHANG = 70;
// A horizontal swipe this long (CSS px) turns pages.
const SWIPE_PX = 60;
// Scroll-ahead choices, ms: how long before the cursor reaches a new line the
// view starts moving to it. Readers' eyes run about a second ahead of their
// hands, so the line they are about to read must already stand still.
const SCROLL_AHEAD_CHOICES = [0, 500, 1000, 1500];
// Taps a lead calibration takes.
const CALIBRATION_TAPS = 8;
const CURSOR_STYLE_NAMES = {
  beats: "Beat glide",
  step: "Beat step",
  even: "Steady bar",
  notes: "Note by note",
  bar: "Bar + beats"
};

const DEFAULT_SETTINGS = {
  /** Name of the part this player reads, carried from song to song. */
  part: "",
  /** Which of its family's instruments that part was (0: first guitar, 1: second…). */
  partIndex: 0,
  /** @type {Record<string, string>} part chosen for one song, by song id */
  songParts: {},
  /** @type {"notes" | "tab"} how a guitarist or bassist reads */
  notation: "tab",
  /**
   * @type {"musescore" | "songsterr"} the band's MuseScore score, or a score
   * imported from Songsterr where a song has one (see resolveScoreSource)
   */
  source: "musescore",
  zoom: 1,
  /** "scroll" (one long column of pages) or "pages" (page turns). */
  layout: "scroll",
  /** @type {"half" | "whole"} page turns: read-ahead half turns, or book order */
  pageTurn: "half",
  /** @type {"top" | "upper" | "middle"} */
  readingLine: "upper",
  /** Shifts only this page's cursor, ms; positive runs ahead of the band. */
  leadMs: 0,
  /** @type {import("./score-timing.js").CursorStyle} how the cursor moves (see cursorAt) */
  motion: "beats",
  /** How long before the cursor reaches a new line the view moves to it, ms. */
  scrollAheadMs: 1000,
  /**
   * @type {Record<string, number>} by song id: the band's bar that a Songsterr
   * import's first bar is (2 with one count-in bar); unset is detected.
   */
  songsterrStarts: {},
  /** Light notes on a dark page, for dark stages. */
  night: false,
  /** Notes only: the score fills the screen. A companion's default. */
  focus: false,
  collapsed: false
};

/**
 * @param {{
 *   root: HTMLElement,
 *   token: string,
 *   isHost: boolean,
 *   roomNow: () => number | undefined,
 *   onPickStart?: (measure: number) => void
 * }} options
 *   onPickStart: the host's "tap a bar to start there" (measure 1-based).
 */
export function createScoreView({ root, token, isHost, roomNow, onPickStart }) {
  const el = {
    title: /** @type {HTMLElement} */ (root.querySelector("#scoreTitle")),
    position: /** @type {HTMLElement} */ (root.querySelector("#scorePosition")),
    jump: /** @type {HTMLElement} */ (root.querySelector("#scoreJump")),
    next: /** @type {HTMLElement} */ (root.querySelector("#scoreNext")),
    announce: /** @type {HTMLElement} */ (root.querySelector("#scoreAnnounce")),
    awake: /** @type {HTMLElement} */ (root.querySelector("#scoreAwake")),
    partSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scorePartSelect")),
    sourceLabel: /** @type {HTMLElement} */ (root.querySelector("#scoreSourceLabel")),
    sourceSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scoreSourceSelect")),
    notation: /** @type {HTMLElement} */ (root.querySelector("#scoreNotation")),
    notesButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreNotesButton")),
    tabButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreTabButton")),
    pickStartButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scorePickStartButton")),
    focusButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreFocusButton")),
    fullscreenButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreFullscreenButton")),
    motionSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scoreMotionSelect")),
    styleButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreStyleButton")),
    scrollAheadSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scoreScrollAheadSelect")),
    songsterrStartLabel: /** @type {HTMLElement} */ (root.querySelector("#scoreSongsterrStartLabel")),
    songsterrStartSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scoreSongsterrStartSelect")),
    calibrateButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreCalibrateButton")),
    calibrate: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreCalibrate")),
    collapseButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreCollapseButton")),
    zoomOut: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreZoomOut")),
    zoomIn: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreZoomIn")),
    zoomLabel: /** @type {HTMLElement} */ (root.querySelector("#scoreZoomLabel")),
    layoutSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scoreLayoutSelect")),
    pageTurnLabel: /** @type {HTMLElement} */ (root.querySelector("#scorePageTurnLabel")),
    pageTurnSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scorePageTurnSelect")),
    readingLineSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scoreReadingLineSelect")),
    nightInput: /** @type {HTMLInputElement} */ (root.querySelector("#scoreNightInput")),
    leadInput: /** @type {HTMLInputElement} */ (root.querySelector("#scoreLeadInput")),
    wakeHint: /** @type {HTMLElement} */ (root.querySelector("#scoreWakeHint")),
    connection: /** @type {HTMLElement} */ (root.querySelector("#scoreConnection")),
    stage: /** @type {HTMLElement} */ (root.querySelector(".score-stage")),
    scroller: /** @type {HTMLElement} */ (root.querySelector("#scoreScroller")),
    pages: /** @type {HTMLElement} */ (root.querySelector("#scorePages")),
    countdown: /** @type {HTMLElement} */ (root.querySelector("#scoreCountdown")),
    follow: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreFollowButton")),
    message: /** @type {HTMLElement} */ (root.querySelector("#scoreMessage"))
  };

  const settings = loadSettings(isHost);
  /** @type {RoomState | undefined} */
  let state;
  /** @type {string | undefined} */
  let songKey;
  /** The latest Play seen for the current song (see resolvePlayhead). */
  /** @type {PlayOfSong | undefined} */
  let lastPlay;

  /**
   * The score on screen. A Songsterr import also carries the band's own score
   * (`reference`): the room plays that one, so its bars and tempos drive the
   * cursor, mapped bar by bar onto the import (see importedSongMs).
   *
   * @type {{ scoreId: string, manifest: ScoreManifest, partId: string, timing: ScoreTiming, reference?: ScoreTiming, detectedShift: number, systems: ReturnType<typeof systemsOf>, pages: { el: HTMLElement, img: HTMLImageElement, width: number, height: number }[], legend?: HTMLElement } | undefined}
   */
  let loaded;
  /** @type {string | undefined} the scoreId being loaded */
  let loadingScoreId;
  /** The score that last failed to load, and when to try it again. */
  /** @type {{ scoreId: string, retryAt: number, message: string } | undefined} */
  let failed;

  /** @type {Map<string, Promise<ScoreManifest>>} */
  const manifestCache = new Map();
  /** @type {Map<string, Promise<ScoreTiming>>} */
  const timingCache = new Map();
  /** @type {HTMLImageElement[]} kept so the browser finishes and keeps them */
  let preloaded = [];
  let preloadedKey = "";

  const cursor = document.createElement("div");
  cursor.className = "score-cursor";
  cursor.setAttribute("aria-hidden", "true");
  const measureMark = document.createElement("div");
  measureMark.className = "score-measure-mark";
  measureMark.setAttribute("aria-hidden", "true");
  const beatFlash = document.createElement("div");
  beatFlash.className = "score-beat-flash";
  beatFlash.setAttribute("aria-hidden", "true");
  el.stage.append(beatFlash);
  // The beats of the current bar, lit one by one (the "bar + beats" style).
  const beatDots = document.createElement("div");
  beatDots.className = "score-beat-dots";
  beatDots.setAttribute("aria-hidden", "true");
  // Where the eye goes next at the end of a line, a repeat or a jump.
  const nextMark = document.createElement("div");
  nextMark.className = "score-next-mark";
  nextMark.setAttribute("aria-hidden", "true");

  const steadyNow = createSteadyClock(roomNow);
  /** Tap errors (room ms) while calibrating the cursor lead; undefined when not. */
  /** @type {number[] | undefined} */
  let calibration;

  let frame = 0;
  let lastSystem = -1;
  /**
   * The line still being played when the view scrolled early to the next one
   * but had to stop short to keep it in view; it scrolls the rest of the way
   * once the cursor leaves it.
   */
  /** @type {number | undefined} */
  let heldBackFor;
  let lastMode = "";
  /**
   * Whether the view should bring the cursor's line into view although nothing
   * runs: after a new song or score, a layout or zoom change. A resize, a turn
   * of the iPad or a return to the tab must not throw away where the player
   * had scrolled to.
   */
  let pendingIdleScroll = true;
  let followPausedUntil = 0;
  /** @type {{ from: number, to: number, startedAt: number } | undefined} */
  let scrollAnimation;
  /** Page shown in page mode while the player turns pages by hand. */
  /** @type {number | undefined} */
  let manualPage;
  /** The page page mode shows first (for turning from it). */
  let shownPage = 0;
  /** The host is choosing a start measure by tapping it. */
  let picking = false;
  /** @type {{ x: number, y: number, at: number } | undefined} */
  let swipeStart;
  let swiped = false;

  const keepAwake = createKeepAwake({ onChange: renderKeepAwake });

  applySettingsToControls();
  wireControls();
  new ResizeObserver(() => {
    lastSystem = -1;
    requestDraw();
  }).observe(el.scroller);

  /** @param {RoomState} next */
  function update(next) {
    state = next;
    const song = next.currentSong?.song;
    const key = song ? `${song.id}:${song.startMeasure ?? 1}` : "";
    if (key !== songKey) {
      songKey = key;
      lastPlay = undefined;
      manualPage = undefined;
      followPausedUntil = 0;
      lastSystem = -1;
      pendingIdleScroll = true;
      setPicking(false);
      renderSongsterrStart();
    }
    // Only a play of this song moves this song's cursor: after the host moves
    // on mid-song the room still plays the old one.
    const play = playOfSong(next.transport, song?.id);
    if (play) {
      lastPlay = play;
    }

    const score = next.currentScore;
    root.hidden = !score;
    document.body.classList.toggle("has-score", Boolean(score));
    if (!score) {
      setFocus(false, false);
      return;
    }
    // Back on a MuseScore song after a song without notes: the score takes the
    // screen again if that is how this device reads.
    if (settings.focus && !document.body.classList.contains("score-focus")) {
      setFocus(true, false);
    }
    const chosen = resolveScoreSource(score, preferredPart(), settings.source);
    el.title.textContent = song?.title ?? "";
    if (chosen?.origin === "songsterr") {
      el.title.textContent += chosen.revision ? ` · Songsterr ${chosen.revision}` : " · Songsterr";
    }
    el.sourceLabel.hidden = !score.imports?.length;

    if (settings.collapsed) {
      // Folded away (the host page's default): fetch nothing until it is opened.
      showMessage("");
    } else if (chosen) {
      if (loaded && loaded.scoreId !== chosen.scoreId) {
        // Never leave another song's notes on screen under this song's title
        // while this one loads (or fails to).
        clearScore();
      }
      const waiting = failed?.scoreId === chosen.scoreId && Date.now() < failed.retryAt;
      if (!loaded && loadingScoreId !== chosen.scoreId && !waiting) {
        void load(chosen.scoreId);
      } else if (!loaded && waiting && failed) {
        showMessage(failed.message);
      }
    } else {
      clearScore();
      const converting = score.imports?.find((entry) => entry.status === "exporting");
      const waitingImport = score.imports?.find((entry) => entry.detail);
      showMessage(score.status === "exporting"
        ? "The MuseScore laptop is exporting the notes for this song…"
        : converting
          ? "The MuseScore laptop is converting the Songsterr import…"
          : (score.scoreId === undefined && waitingImport?.detail) || score.detail || "No notes for this song.");
    }
    renderNextSong(next);
    preloadNextSong(next);
    requestDraw();
  }

  /** The part this player wants for the current song. */
  function preferredPart() {
    const songId = state?.currentSong?.song?.id;
    return (songId && settings.songParts[songId]) || settings.part;
  }

  /** @param {string} connection */
  function setConnection(connection) {
    const offline = connection !== "open";
    el.connection.hidden = !offline;
    el.connection.textContent = offline ? "Offline – reconnecting" : "";
    root.classList.toggle("is-offline", offline);
  }

  /** @param {string} scoreId */
  async function load(scoreId) {
    loadingScoreId = scoreId;
    showMessage(loaded ? "" : "Loading the notes…");
    try {
      const manifest = await fetchManifest(scoreId);
      const partId = choosePart(manifest.parts, preferredPart(), settings.notation, settings.partIndex) ?? manifest.parts[0]?.id;
      const part = manifest.parts.find((candidate) => candidate.id === partId);
      if (!part) {
        throw new Error("The export lists no parts.");
      }
      const timing = await fetchTiming(scoreId, part.timing);
      const reference = await referenceTimingFor(scoreId);
      if (resolveScoreSource(state?.currentScore, preferredPart(), settings.source)?.scoreId !== scoreId) {
        return;
      }
      showScore(scoreId, manifest, part.id, timing, reference);
      if (failed?.scoreId === scoreId) {
        failed = undefined;
      }
    } catch (error) {
      const message = `Could not load the notes: ${error instanceof Error ? error.message : String(error)}`;
      failed = { scoreId, retryAt: Date.now() + LOAD_RETRY_MS, message };
      if (resolveScoreSource(state?.currentScore, preferredPart(), settings.source)?.scoreId === scoreId) {
        showMessage(message);
      }
      setTimeout(() => state && update(state), LOAD_RETRY_MS + 100);
    } finally {
      if (loadingScoreId === scoreId) {
        loadingScoreId = undefined;
      }
    }
  }

  /**
   * The band's own score's timing when `scoreId` is a Songsterr import of the
   * current song that has one: the room plays the band's score, so its bars
   * are the truth. Any of its parts will do -- they share bars and tempos.
   *
   * @param {string} scoreId
   * @returns {Promise<ScoreTiming | undefined>}
   */
  async function referenceTimingFor(scoreId) {
    const score = state?.currentScore;
    const own = score?.status === "ready" ? score.scoreId : undefined;
    if (!own || own === scoreId || !score?.imports?.some((entry) => entry.scoreId === scoreId)) {
      return undefined;
    }
    try {
      const manifest = await fetchManifest(own);
      const part = manifest.parts[0];
      return part ? await fetchTiming(own, part.timing) : undefined;
    } catch {
      // Without it the import runs on its own timing, as before.
      return undefined;
    }
  }

  /**
   * @param {string} scoreId
   * @param {ScoreManifest} manifest
   * @param {string} partId
   * @param {ScoreTiming} timing
   * @param {ScoreTiming} [reference] see `loaded`
   */
  function showScore(scoreId, manifest, partId, timing, reference) {
    const part = manifest.parts.find((candidate) => candidate.id === partId);
    if (!part) {
      return;
    }
    el.pages.replaceChildren();
    const pages = part.pages.map((file, index) => {
      const size = timing.pages[index] ?? timing.pages[0] ?? { width: 9924, height: 14028 };
      const page = document.createElement("div");
      page.className = "score-page";
      page.style.aspectRatio = `${size.width} / ${size.height}`;
      page.dataset.page = String(index);
      const img = document.createElement("img");
      img.alt = `${manifest.title}, page ${index + 1}`;
      img.decoding = "async";
      img.draggable = false;
      // The first pages load now; the rest as they come near (scroll mode) or
      // are about to be turned to (see loadPagesAround).
      img.loading = index < 2 ? "eager" : "lazy";
      img.src = scoreFileUrl(scoreId, file);
      const number = document.createElement("span");
      number.className = "score-page-number";
      number.textContent = String(index + 1);
      number.setAttribute("aria-hidden", "true");
      page.append(img, number);
      el.pages.append(page);
      return { el: page, img, width: size.width, height: size.height };
    });
    const legend = part.legend ? drumKey(scoreId, part.legend, pages[0]?.width ?? 9924) : undefined;
    if (legend) {
      el.pages.prepend(legend);
    }
    loaded = {
      scoreId,
      manifest,
      partId,
      timing,
      reference,
      detectedShift: reference ? detectBarOffset(reference, timing) : 0,
      systems: systemsOf(timing),
      pages,
      legend
    };
    renderSongsterrStart();

    const instruments = instrumentsOf(manifest.parts);
    const current = manifest.parts.find((candidate) => candidate.id === partId);
    const currentKey = current?.instrument ?? partId;
    el.partSelect.replaceChildren(...instruments.map((instrument) => {
      const option = document.createElement("option");
      option.value = instrument.key;
      option.textContent = instrument.name;
      option.selected = instrument.key === currentKey;
      return option;
    }));
    el.partSelect.disabled = instruments.length < 2;
    // Notes or tab: only for an instrument that comes both ways.
    const notations = instruments.find((instrument) => instrument.key === currentKey)?.notations ?? [];
    el.notation.hidden = notations.length < 2;
    el.notesButton.setAttribute("aria-pressed", String(current?.notation === "notes"));
    el.tabButton.setAttribute("aria-pressed", String(current?.notation === "tab"));
    el.pickStartButton.hidden = !onPickStart;
    showMessage("");
    lastSystem = -1;
    pendingIdleScroll = true;
    manualPage = undefined;
    applyLayout();
    requestDraw();
  }

  /**
   * The drum key: which line and notehead is which drum. Above page 1 in
   * scroll mode; laid over the top of page 1 while it is shown in page mode.
   *
   * @param {string} scoreId
   * @param {{ file: string, width: number, height: number }} legend
   * @param {number} pageWidth SVG units, so the key is drawn at the pages' scale
   */
  function drumKey(scoreId, legend, pageWidth) {
    const box = document.createElement("figure");
    box.className = "score-legend";
    const label = document.createElement("figcaption");
    label.textContent = "Drum key";
    const img = document.createElement("img");
    img.alt = "Drum key: which line and notehead is which drum";
    img.decoding = "async";
    img.draggable = false;
    img.src = scoreFileUrl(scoreId, legend.file);
    img.style.aspectRatio = `${legend.width} / ${legend.height}`;
    img.style.width = `${Math.min(100, (legend.width / pageWidth) * 100)}%`;
    box.append(label, img);
    return box;
  }

  /** Page mode: the key sits on page 1, across its width, while page 1 is shown. */
  function placeLegend() {
    const legend = loaded?.legend;
    if (!legend) {
      return;
    }
    const first = loaded?.pages[0];
    const overlay = settings.layout === "pages";
    legend.hidden = overlay && !first?.el.classList.contains("is-shown");
    legend.style.left = overlay && first ? `${first.el.offsetLeft}px` : "";
    legend.style.width = overlay && first ? `${first.el.clientWidth}px` : "";
  }

  function clearScore() {
    if (!loaded) {
      return;
    }
    loaded = undefined;
    el.pages.replaceChildren();
    el.partSelect.replaceChildren();
    el.position.textContent = "";
    el.jump.hidden = true;
    el.countdown.hidden = true;
    el.pickStartButton.hidden = true;
    setPicking(false);
  }

  /** @param {string} text */
  function showMessage(text) {
    el.message.textContent = text;
    el.message.hidden = !text;
  }

  /** @param {string} text */
  function announce(text) {
    // A polite live region, written only when something changes: the bar
    // number and the countdown change every frame and must not be read out.
    el.announce.textContent = text;
  }

  function requestDraw() {
    if (!frame) {
      frame = requestAnimationFrame(draw);
    }
  }

  /**
   * How many bars the Songsterr import on screen is shifted against the band's
   * score: the player's choice for this song, else the detected shift.
   */
  function barShift() {
    if (!loaded?.reference) {
      return 0;
    }
    const songId = state?.currentSong?.song?.id;
    const start = songId ? settings.songsterrStarts[songId] : undefined;
    return start ? start - 1 : loaded.detectedShift;
  }

  /**
   * Where the song is at room time `synced`, on the band's score (an import's
   * reference, else the score on screen).
   *
   * @param {number | undefined} synced room time, undefined until the clock syncs
   * @param {number} leadMs
   */
  function songClock(synced, leadMs) {
    const current = /** @type {NonNullable<typeof loaded>} */ (loaded);
    const now = synced ?? Date.now();
    const song = state?.currentSong?.song;
    const playhead = resolvePlayhead(state?.transport, lastPlay, now, song?.id);
    // The run's own start and tempo when the room says what they were (the
    // host may edit the song while it plays); else the song's.
    const run = playhead.play && "startMeasure" in playhead.play ? playhead.play : song;
    const timeline = current.reference ?? current.timing;
    const offset = startOffsetMs(timeline, run?.startMeasure);
    let songMs = offset;
    if (synced !== undefined && playhead.downbeatServerTime !== undefined &&
        (playhead.mode === "running" || playhead.mode === "stopped")) {
      const at = playhead.mode === "stopped" ? Math.min(now, playhead.stoppedAtServerTime ?? now) : now;
      // The lead applies to the stopped cursor too, so Stop freezes it where
      // the player saw it rather than a lead's worth earlier.
      songMs = Math.max(offset, songTimeMs({
        roomNowMs: at,
        downbeatServerTime: playhead.downbeatServerTime,
        startOffsetMs: offset,
        tempoPercent: run?.tempoPercent,
        leadMs
      }));
    }
    return { playhead, run, timeline, offset, songMs, rate: normalizedTempo(run?.tempoPercent) / 100 };
  }

  /** @param {number} songMs the band's song time; returns the time of the score on screen */
  function viewMs(songMs) {
    const current = /** @type {NonNullable<typeof loaded>} */ (loaded);
    return current.reference ? importedSongMs(current.reference, current.timing, songMs, barShift()) : songMs;
  }

  function draw() {
    frame = 0;
    if (!loaded || !state || root.hidden) {
      return;
    }
    const synced = steadyNow();
    const { playhead, run, timeline, offset, songMs, rate } = songClock(synced, settings.leadMs);
    const following = playhead.mode === "running" || playhead.mode === "countdown";

    const position = cursorAt(loaded.timing, viewMs(songMs), { motion: settings.motion });
    if (position) {
      placeCursor(position);
      placeNextMark(position, playhead.mode === "running");
      // On an import the bar number is the band's, so everyone calls out the same bar.
      const bandPass = timeline.events[Math.max(0, findPassIndex(timeline.events, songMs))];
      const bar = loaded.reference ? (bandPass?.m ?? 0) + 1 : position.measureIndex + 1;
      const total = loaded.reference
        ? loaded.reference.measures.length
        : loaded.manifest.parts.find((part) => part.id === loaded?.partId)?.measureCount ?? 0;
      const section = sectionAt(loaded.timing, position.measureIndex);
      el.position.textContent = `Bar ${bar}${total ? ` / ${total}` : ""}` +
        (section ? ` · ${section}` : "") +
        (position.passNumber > 1 ? ` · ${ordinal(position.passNumber)} time` : "");
      // Where the music goes next when it does not just carry on: shown on the
      // whole measure before a repeat or jump, so it is never a surprise.
      const jump = jumpAfter(loaded.timing.events, position.passIndex);
      el.jump.hidden = !jump;
      if (jump) {
        const to = loaded.reference
          ? (referenceMeasureOf(loaded.reference, loaded.timing, jump.toMeasureIndex, barShift()) ?? jump.toMeasureIndex)
          : jump.toMeasureIndex;
        el.jump.textContent = jump.kind === "repeat" ? `↻ back to bar ${to + 1}` : `→ jump to bar ${to + 1}`;
      }
      measureMark.classList.toggle("is-before-jump", Boolean(jump));
    }

    // A Songsterr score starts where the band's count-in bars end: count those
    // in too, in one run with the wait before the downbeat.
    const shift = barShift();
    const musicStart = shift > 0 ? timeline.events[shift]?.t : undefined;
    const countsBars = musicStart !== undefined && musicStart > offset;
    /** @type {number | undefined} room ms left until the first bar of the notes on screen */
    let countInMs = playhead.mode === "countdown" ? playhead.remainingMs ?? 0 : undefined;
    if (countsBars && playhead.mode === "countdown") {
      countInMs = (countInMs ?? 0) + (/** @type {number} */ (musicStart) - offset) / rate;
    } else if (countsBars && playhead.mode === "running" && songMs < /** @type {number} */ (musicStart)) {
      countInMs = (/** @type {number} */ (musicStart) - songMs) / rate;
    }
    const firstBar = countsBars ? (timeline.events[shift]?.m ?? 0) + 1 : run?.startMeasure;
    renderCountdown(playhead, countInMs, timeline, firstBar, run?.tempoPercent);
    renderCalibration(playhead.mode);

    if (playhead.mode !== lastMode) {
      if (playhead.mode === "countdown") {
        // A new run: show its start, wherever the player had scrolled.
        followPausedUntil = 0;
        manualPage = undefined;
        lastSystem = -1;
        setPicking(false);
      }
      announceMode(playhead.mode, position);
      lastMode = playhead.mode;
    }
    root.dataset.mode = playhead.mode;
    el.follow.hidden = !(following && Date.now() < followPausedUntil);
    el.pickStartButton.disabled = following;
    if (!following && scrollAnimation) {
      // Only a run animates the view. Land its last line now: left to a later
      // frame (a busy tablet can be slow to draw one), it would pull the view
      // back after the player has scrolled away from the stopped cursor.
      el.scroller.scrollTop = scrollAnimation.to;
      scrollAnimation = undefined;
    }

    if (position) {
      // The line the eyes need next: where the cursor will be a moment from
      // now (scroll ahead), so the view stands still before the cursor gets there.
      const ahead = playhead.mode === "running" && settings.scrollAheadMs > 0
        ? cursorAt(loaded.timing, viewMs(songMs + settings.scrollAheadMs * rate), { motion: "even" })
        : undefined;
      follow(position, following, ahead);
    }
    if (following || scrollAnimation) {
      frame = requestAnimationFrame(draw);
    }
  }

  /**
   * @param {ReturnType<typeof resolvePlayhead>} playhead
   * @param {number | undefined} countInMs room ms left until the notes start; undefined: no count-in now
   * @param {ScoreTiming} timeline the band's score
   * @param {number | undefined} firstBar the bar counted in to
   * @param {number | undefined} tempoPercent
   */
  function renderCountdown(playhead, countInMs, timeline, firstBar, tempoPercent) {
    beatFlash.classList.remove("is-on");
    if (playhead.mode === "elsewhere") {
      el.countdown.hidden = false;
      el.countdown.classList.remove("is-beat");
      el.countdown.textContent = "Band is on another song";
      return;
    }
    if (countInMs === undefined || !loaded) {
      el.countdown.hidden = true;
      return;
    }
    el.countdown.hidden = false;
    if (roomNow() === undefined) {
      el.countdown.classList.remove("is-beat");
      el.countdown.textContent = "Syncing clock…";
      return;
    }
    const beats = countInState(countInMs, countInBeat(timeline, firstBar, tempoPercent));
    if (beats) {
      // The count-in in beats, flashing on each one -- in the bar and along the
      // top edge, never over the start measure.
      el.countdown.classList.add("is-beat");
      el.countdown.textContent = `Count-in ${beats.beatsLeft}`;
      beatFlash.classList.toggle("is-on", beats.phase < 0.22);
    } else {
      el.countdown.classList.remove("is-beat");
      el.countdown.textContent = `Starts in ${(countInMs / 1000).toFixed(1)} s`;
    }
  }

  /**
   * @param {string} mode
   * @param {ReturnType<typeof cursorAt>} position
   */
  function announceMode(mode, position) {
    const bar = position ? position.measureIndex + 1 : 1;
    const text = {
      countdown: `Count-in. Starting at bar ${bar}.`,
      running: "Playing.",
      stopped: `Stopped at bar ${bar}.`,
      elsewhere: "The band is playing another song.",
      idle: ""
    }[mode] ?? "";
    // The first draw of a page is not news.
    if (lastMode && text) {
      announce(text);
    }
  }

  /** @param {NonNullable<ReturnType<typeof cursorAt>>} position */
  function placeCursor(position) {
    const page = loaded?.pages[position.page];
    if (!page) {
      return;
    }
    loadPagesAround(position.page);
    if (cursor.parentElement !== page.el) {
      page.el.append(measureMark, cursor, beatDots);
    }
    root.dataset.cursorStyle = settings.motion;
    const scale = page.el.clientWidth / page.width;
    const { measure } = position;
    const top = (measure.y - CURSOR_OVERHANG) * scale;
    const height = (measure.h + CURSOR_OVERHANG * 2) * scale;
    const width = Math.max(3, CURSOR_WIDTH * scale);
    cursor.style.width = `${width}px`;
    cursor.style.height = `${height}px`;
    cursor.style.transform = `translate3d(${position.x * scale - width / 2}px, ${top}px, 0)`;
    measureMark.style.width = `${measure.w * scale}px`;
    measureMark.style.height = `${height}px`;
    measureMark.style.transform = `translate3d(${measure.x * scale}px, ${top}px, 0)`;

    beatDots.hidden = settings.motion !== "bar";
    if (settings.motion === "bar") {
      // One dot per beat under the bar; the one being played is lit.
      const { count, index } = position.beat;
      if (beatDots.childElementCount !== count) {
        beatDots.replaceChildren(...Array.from({ length: count }, () => document.createElement("span")));
      }
      [...beatDots.children].forEach((dot, dotIndex) => {
        dot.classList.toggle("is-now", dotIndex === index);
        dot.classList.toggle("is-past", dotIndex < index);
      });
      beatDots.style.width = `${measure.w * scale}px`;
      beatDots.style.transform = `translate3d(${measure.x * scale}px, ${top + height}px, 0)`;
    }
  }

  /**
   * In the last beat before the music leaves the line (or repeats, or jumps),
   * a faint box on the bar that comes next, so the eye knows where to go.
   *
   * @param {NonNullable<ReturnType<typeof cursorAt>>} position
   * @param {boolean} running
   */
  function placeNextMark(position, running) {
    const timing = loaded?.timing;
    const next = timing?.events[position.passIndex + 1];
    const measure = next ? timing?.measures[next.m] : undefined;
    const page = measure ? loaded?.pages[measure.page] : undefined;
    const systems = loaded?.systems.systemOfMeasure ?? [];
    const flows = next !== undefined && next.m === position.measureIndex + 1 &&
      systems[next.m] === systems[position.measureIndex];
    const show = running && !flows && Boolean(measure && page) && position.beat.index >= position.beat.count - 1;
    nextMark.hidden = !show;
    if (!show || !measure || !page) {
      return;
    }
    if (nextMark.parentElement !== page.el) {
      page.el.append(nextMark);
    }
    const scale = page.el.clientWidth / page.width;
    nextMark.style.width = `${measure.w * scale}px`;
    nextMark.style.height = `${(measure.h + CURSOR_OVERHANG * 2) * scale}px`;
    nextMark.style.transform = `translate3d(${measure.x * scale}px, ${(measure.y - CURSOR_OVERHANG) * scale}px, 0)`;
  }

  /**
   * Lazy pages load as they scroll near, but the cursor's page and the next
   * ones must never wait for that: a page turn or a jump would show a blank.
   *
   * @param {number} page
   */
  function loadPagesAround(page) {
    for (let index = page - 1; index <= page + 2; index += 1) {
      const candidate = loaded?.pages[index];
      if (candidate && candidate.img.loading !== "eager") {
        candidate.img.loading = "eager";
      }
    }
  }

  /**
   * @param {NonNullable<ReturnType<typeof cursorAt>>} position
   * @param {boolean} following
   * @param {ReturnType<typeof cursorAt>} [ahead] where the cursor will be a moment from now
   */
  function follow(position, following, ahead) {
    if (!loaded) {
      return;
    }
    const paused = Date.now() < followPausedUntil;
    if (settings.layout === "pages") {
      const byHand = manualPage !== undefined && (!following || paused);
      // Turn early to the page coming up, as long as the page being played
      // stays in view beside it.
      const early = ahead && visiblePages(ahead.page, loaded.pages.length, pageSlots(), settings.pageTurn).includes(position.page);
      showPages(byHand ? /** @type {number} */ (manualPage) : early ? /** @type {NonNullable<typeof ahead>} */ (ahead).page : position.page);
      pendingIdleScroll = false;
      return;
    }

    const currentSystem = loaded.systems.systemOfMeasure[position.measureIndex] ?? 0;
    const systemIndex = following && ahead ? loaded.systems.systemOfMeasure[ahead.measureIndex] ?? currentSystem : currentSystem;
    // Scroll on a new line (or a fresh layout) while the song runs -- a moment
    // before the cursor gets there -- and once more when it does if the early
    // scroll had to hold back to keep the line being played in view. While
    // nothing runs, only when asked to (a new song, zoom, layout) -- never
    // because the window changed size.
    const wanted = following
      ? systemIndex !== lastSystem || (heldBackFor !== undefined && heldBackFor !== currentSystem)
      : pendingIdleScroll;
    if (wanted && !paused) {
      lastSystem = systemIndex;
      pendingIdleScroll = false;
      heldBackFor = undefined;
      let target = followTargetFor(systemIndex);
      const playing = loaded.systems.systems[currentSystem];
      if (target !== undefined && systemIndex !== currentSystem && playing) {
        const line = systemBox(playing);
        const margin = 8;
        const held = Math.max(line.bottom - el.scroller.clientHeight + margin, Math.min(target, line.top - margin));
        if (Math.abs(held - target) > 1) {
          heldBackFor = currentSystem;
          target = held;
        }
      }
      if (target !== undefined) {
        scrollTo(target, following && lastMode === "running");
      }
      keepCursorInViewHorizontally(position);
    } else if (following && !paused) {
      keepCursorInViewHorizontally(position);
    }
    stepScrollAnimation();
  }

  /** @param {number} systemIndex */
  function followTargetFor(systemIndex) {
    if (!loaded) {
      return undefined;
    }
    const system = loaded.systems.systems[systemIndex];
    const next = loaded.systems.systems[systemIndex + 1];
    if (!system) {
      return undefined;
    }
    const line = systemBox(system);
    const nextLine = next ? systemBox(next) : undefined;
    // The first line keeps the drum key above it in view while it fits.
    if (systemIndex === 0 && loaded.legend && settings.layout === "scroll" && line.bottom <= el.scroller.clientHeight) {
      return 0;
    }
    return followScrollTop({
      lineTop: line.top,
      lineBottom: line.bottom,
      nextBottom: nextLine?.bottom,
      viewportHeight: el.scroller.clientHeight,
      readingLine: READING_LINES[settings.readingLine] ?? READING_LINES.upper
    });
  }

  /** @param {{ page: number, top: number, bottom: number }} system */
  function systemBox(system) {
    const page = /** @type {NonNullable<typeof loaded>} */ (loaded).pages[system.page];
    const scale = page.el.clientWidth / page.width;
    const offsetTop = page.el.offsetTop;
    return {
      top: offsetTop + (system.top - CURSOR_OVERHANG) * scale,
      bottom: offsetTop + (system.bottom + CURSOR_OVERHANG) * scale
    };
  }

  /**
   * @param {number} target
   * @param {boolean} animate
   */
  function scrollTo(target, animate) {
    const max = el.scroller.scrollHeight - el.scroller.clientHeight;
    const to = Math.max(0, Math.min(max, target));
    if (!animate || Math.abs(to - el.scroller.scrollTop) < 2) {
      scrollAnimation = undefined;
      el.scroller.scrollTop = to;
      return;
    }
    scrollAnimation = { from: el.scroller.scrollTop, to, startedAt: performance.now() };
  }

  function stepScrollAnimation() {
    if (!scrollAnimation) {
      return;
    }
    const progress = Math.min(1, (performance.now() - scrollAnimation.startedAt) / FOLLOW_ANIMATION_MS);
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
    el.scroller.scrollTop = scrollAnimation.from + (scrollAnimation.to - scrollAnimation.from) * eased;
    if (progress >= 1) {
      scrollAnimation = undefined;
    }
  }

  /** When zoomed in past the width of the view, keep the cursor in sight sideways. */
  /** @param {NonNullable<ReturnType<typeof cursorAt>>} position */
  function keepCursorInViewHorizontally(position) {
    const scroller = el.scroller;
    if (scroller.scrollWidth <= scroller.clientWidth + 1 || !loaded) {
      return;
    }
    const page = loaded.pages[position.page];
    const x = page.el.offsetLeft + position.x * (page.el.clientWidth / page.width);
    if (x < scroller.scrollLeft + scroller.clientWidth * 0.1 || x > scroller.scrollLeft + scroller.clientWidth * 0.85) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * 0.3);
    }
  }

  function pageSlots() {
    return el.scroller.clientWidth > el.scroller.clientHeight * 1.15 ? 2 : 1;
  }

  /** @param {number} page */
  function showPages(page) {
    if (!loaded) {
      return;
    }
    const shown = visiblePages(page, loaded.pages.length, pageSlots(), settings.pageTurn);
    shownPage = Math.min(...shown);
    for (const index of shown) {
      loadPagesAround(index);
    }
    loaded.pages.forEach((candidate, index) => {
      const position = shown.indexOf(index);
      candidate.el.classList.toggle("is-shown", position >= 0);
      candidate.el.style.order = String(Math.max(0, position));
    });
    placeLegend();
  }

  /**
   * Turns pages by hand (a tap on an edge, a swipe). While a song runs this
   * holds for a few seconds, then the view follows the cursor again.
   *
   * @param {-1 | 1} direction
   */
  function turnPages(direction) {
    if (!loaded) {
      return;
    }
    const from = manualPage ?? shownPage;
    manualPage = Math.max(0, Math.min(loaded.pages.length - 1, from + direction * pageSlots()));
    if (lastMode === "running" || lastMode === "countdown") {
      followPausedUntil = Date.now() + FOLLOW_PAUSE_MS;
      setTimeout(requestDraw, FOLLOW_PAUSE_MS + 50);
    }
    requestDraw();
  }

  function applyLayout() {
    root.dataset.layout = settings.layout;
    root.classList.toggle("is-night", settings.night);
    el.pages.style.width = settings.layout === "scroll" ? `${Math.round(settings.zoom * 100)}%` : "";
    el.zoomLabel.textContent = `${Math.round(settings.zoom * 100)}%`;
    el.zoomIn.disabled = settings.layout !== "scroll" || settings.zoom >= 2;
    el.zoomOut.disabled = settings.layout !== "scroll" || settings.zoom <= 0.5;
    el.pageTurnLabel.hidden = settings.layout !== "pages";
    if (settings.layout === "scroll") {
      loaded?.pages.forEach((page) => {
        page.el.classList.remove("is-shown");
        page.el.style.order = "";
      });
    }
    placeLegend();
    lastSystem = -1;
    pendingIdleScroll = true;
    requestDraw();
  }

  /**
   * @param {boolean} on
   * @param {boolean} [remember]
   */
  function setFocus(on, remember = true) {
    document.body.classList.toggle("score-focus", on);
    el.focusButton.textContent = on ? "Show room" : "Notes only";
    el.focusButton.setAttribute("aria-pressed", String(on));
    if (remember) {
      settings.focus = on;
      saveSettings(settings);
    }
    if (!on && fullscreenElement()) {
      void exitFullscreen();
    }
    keepAwake.set(on);
    lastSystem = -1;
    pendingIdleScroll = true;
    requestDraw();
  }

  // Real full screen (no browser bars) where the browser allows it for a page:
  // desktop browsers and Safari on iPad, but not on iPhone. Started from the
  // home screen, iPadOS shows the page without bars anyway.
  async function toggleFullscreen() {
    if (fullscreenElement()) {
      await exitFullscreen();
      return;
    }
    setFocus(true);
    const page = /** @type {any} */ (document.documentElement);
    try {
      await (page.requestFullscreen?.() ?? page.webkitRequestFullscreen?.());
    } catch {
      // Refused (e.g. not from a tap): notes only still fills the window.
    }
  }

  function renderFullscreenButton() {
    const page = /** @type {any} */ (document.documentElement);
    el.fullscreenButton.hidden = !(page.requestFullscreen || page.webkitRequestFullscreen);
    const on = Boolean(fullscreenElement());
    el.fullscreenButton.textContent = on ? "Exit full screen" : "Full screen";
    el.fullscreenButton.setAttribute("aria-pressed", String(on));
    lastSystem = -1;
    requestDraw();
  }

  /** @param {import("./keep-awake.js").KeepAwakeState} awake */
  function renderKeepAwake(awake) {
    el.awake.hidden = awake !== "needs-tap";
    root.dataset.keepAwake = awake;
    el.wakeHint.textContent = awake === "lock"
      ? "This screen stays on while the notes fill it."
      : awake === "video"
        ? "This screen stays on while the notes fill it. If it still dims, set Auto-Lock to Never (iPad: Settings › Display & Brightness)."
        : "Keep this screen on: tap the notes once, or set Auto-Lock to Never (iPad: Settings › Display & Brightness).";
  }

  /** Shows the cursor style's name on its button. */
  function renderCursorStyle() {
    el.motionSelect.value = settings.motion;
    el.styleButton.textContent = `Cursor: ${CURSOR_STYLE_NAMES[settings.motion]}`;
    root.dataset.cursorStyle = settings.motion;
  }

  /** @param {import("./score-timing.js").CursorStyle} style */
  function setCursorStyle(style) {
    settings.motion = style;
    saveSettings(settings);
    renderCursorStyle();
    requestDraw();
  }

  /**
   * "Songsterr bar 1 is the band's bar …": shown for an import that runs on the
   * band's score, with the detected bar as "auto".
   */
  function renderSongsterrStart() {
    const reference = loaded?.reference;
    el.songsterrStartLabel.hidden = !reference;
    if (!reference || !loaded) {
      return;
    }
    const songId = state?.currentSong?.song?.id;
    const chosen = songId ? settings.songsterrStarts[songId] : undefined;
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = `Auto (bar ${loaded.detectedShift + 1})`;
    el.songsterrStartSelect.replaceChildren(auto, ...[1, 2, 3, 4, 5].map((bar) => {
      const option = document.createElement("option");
      option.value = String(bar);
      option.textContent = `Bar ${bar}`;
      return option;
    }));
    el.songsterrStartSelect.value = chosen ? String(chosen) : "";
  }

  /**
   * Tap along with the beat while the band plays; the cursor lead is set from
   * where the taps landed (see leadFromTaps).
   *
   * @param {string} mode
   */
  function renderCalibration(mode) {
    el.calibrate.hidden = calibration === undefined;
    if (calibration === undefined) {
      return;
    }
    el.calibrate.textContent = mode === "running"
      ? `Tap with the beat · ${calibration.length} / ${CALIBRATION_TAPS} · tap here`
      : "Start the song, then tap with the beat here";
  }

  /** @param {number} eventTimeStamp the tap's event.timeStamp (performance clock) */
  function calibrationTap(eventTimeStamp) {
    if (!loaded || calibration === undefined) {
      return;
    }
    const synced = steadyNow();
    if (synced === undefined) {
      return;
    }
    const tapAt = synced - Math.max(0, performance.now() - eventTimeStamp);
    const { playhead, timeline, songMs, rate } = songClock(tapAt, 0);
    if (playhead.mode !== "running") {
      return;
    }
    const beat = nearestBeatMs(timeline, songMs);
    if (beat === undefined) {
      return;
    }
    calibration.push((songMs - beat) / rate);
    if (calibration.length < CALIBRATION_TAPS) {
      renderCalibration(playhead.mode);
      return;
    }
    const lead = leadFromTaps(calibration);
    calibration = undefined;
    el.calibrateButton.textContent = "Calibrate";
    if (lead !== undefined) {
      settings.leadMs = lead;
      el.leadInput.value = String(lead);
      saveSettings(settings);
      announce(`Cursor lead set to ${lead} ms.`);
    }
    renderCalibration(playhead.mode);
    requestDraw();
  }

  /** @param {boolean} on */
  function setPicking(on) {
    picking = on && Boolean(onPickStart) && Boolean(loaded);
    root.classList.toggle("is-picking", picking);
    el.pickStartButton.setAttribute("aria-pressed", String(picking));
    el.pickStartButton.textContent = picking ? "Tap a bar…" : "Set start bar";
  }

  /** @param {MouseEvent} event */
  function pickAt(event) {
    if (!loaded || !onPickStart) {
      return;
    }
    const target = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest?.(".score-page"));
    const index = Number(target?.dataset.page);
    const page = loaded.pages[index];
    if (!target || !page) {
      return;
    }
    const bounds = target.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * page.width;
    const y = (event.clientY - bounds.top) / bounds.height * page.height;
    const measureIndex = measureAtPoint(loaded.timing, index, x, y);
    if (measureIndex === undefined) {
      announce("No bar there. Tap a bar of music.");
      return;
    }
    const bandMeasure = loaded.reference
      ? referenceMeasureOf(loaded.reference, loaded.timing, measureIndex, barShift())
      : measureIndex;
    if (bandMeasure === undefined) {
      announce("That bar is not in the band's score.");
      return;
    }
    setPicking(false);
    onPickStart(bandMeasure + 1);
    announce(`Start bar set to ${bandMeasure + 1}.`);
  }

  function applySettingsToControls() {
    el.layoutSelect.value = settings.layout;
    el.pageTurnSelect.value = settings.pageTurn;
    el.readingLineSelect.value = settings.readingLine;
    el.leadInput.value = String(settings.leadMs);
    renderCursorStyle();
    el.scrollAheadSelect.value = String(settings.scrollAheadMs);
    el.sourceSelect.value = settings.source;
    el.nightInput.checked = settings.night;
    root.classList.toggle("is-night", settings.night);
    el.pageTurnLabel.hidden = settings.layout !== "pages";
    renderFullscreenButton();
    renderKeepAwake(keepAwake.state);
    root.classList.toggle("is-collapsed", settings.collapsed);
    el.collapseButton.textContent = settings.collapsed ? "Show notes" : "Hide notes";
    el.collapseButton.setAttribute("aria-expanded", String(!settings.collapsed));
    if (settings.focus) {
      setFocus(true, false);
    }
  }

  function wireControls() {
    el.partSelect.addEventListener("change", () => {
      if (!loaded) {
        return;
      }
      const partId = partInNotation(loaded.manifest.parts, el.partSelect.value, settings.notation);
      const part = loaded.manifest.parts.find((candidate) => candidate.id === partId);
      if (!part) {
        return;
      }
      const name = part.id === "score" ? "" : part.name;
      settings.part = name;
      settings.partIndex = familyIndexOf(loaded.manifest.parts, part.id);
      const songId = state?.currentSong?.song?.id;
      if (songId) {
        rememberSongPart(songId, name);
      }
      saveSettings(settings);
      // Another instrument may read another Songsterr import (the drummer's page).
      const target = resolveScoreSource(state?.currentScore, preferredPart(), settings.source);
      if (state && target && target.scoreId !== loaded.scoreId) {
        update(state);
        return;
      }
      switchPart(part.id);
    });
    el.sourceSelect.addEventListener("change", () => {
      settings.source = el.sourceSelect.value === "songsterr" ? "songsterr" : "musescore";
      saveSettings(settings);
      if (state) {
        update(state);
      }
    });
    for (const [button, notation] of /** @type {const} */ ([[el.notesButton, "notes"], [el.tabButton, "tab"]])) {
      button.addEventListener("click", () => {
        if (!loaded) {
          return;
        }
        settings.notation = notation;
        saveSettings(settings);
        const current = loaded.manifest.parts.find((candidate) => candidate.id === loaded?.partId);
        const partId = partInNotation(loaded.manifest.parts, current?.instrument ?? loaded.partId, notation);
        if (partId && partId !== loaded.partId) {
          switchPart(partId);
        }
      });
    }
    el.pickStartButton.addEventListener("click", () => setPicking(!picking));
    el.focusButton.addEventListener("click", () => setFocus(!document.body.classList.contains("score-focus")));
    el.fullscreenButton.addEventListener("click", () => void toggleFullscreen());
    document.addEventListener("fullscreenchange", renderFullscreenButton);
    document.addEventListener("webkitfullscreenchange", renderFullscreenButton);
    el.motionSelect.addEventListener("change", () => {
      const style = CURSOR_STYLES.find((candidate) => candidate === el.motionSelect.value);
      setCursorStyle(style ?? "beats");
    });
    // Next style in one tap (or the C key), to compare them while the band plays.
    el.styleButton.addEventListener("click", () =>
      setCursorStyle(CURSOR_STYLES[(CURSOR_STYLES.indexOf(settings.motion) + 1) % CURSOR_STYLES.length]));
    el.scrollAheadSelect.addEventListener("change", () => {
      const value = Number(el.scrollAheadSelect.value);
      settings.scrollAheadMs = SCROLL_AHEAD_CHOICES.includes(value) ? value : 1000;
      saveSettings(settings);
      lastSystem = -1;
      requestDraw();
    });
    el.songsterrStartSelect.addEventListener("change", () => {
      const songId = state?.currentSong?.song?.id;
      if (!songId) {
        return;
      }
      const bar = Number(el.songsterrStartSelect.value);
      if (bar >= 1 && bar <= 5) {
        settings.songsterrStarts[songId] = bar;
      } else {
        delete settings.songsterrStarts[songId];
      }
      const ids = Object.keys(settings.songsterrStarts);
      for (const old of ids.slice(0, Math.max(0, ids.length - SONG_PART_LIMIT))) {
        delete settings.songsterrStarts[old];
      }
      saveSettings(settings);
      lastSystem = -1;
      requestDraw();
    });
    el.calibrateButton.addEventListener("click", () => {
      calibration = calibration === undefined ? [] : undefined;
      el.calibrateButton.textContent = calibration ? "Cancel" : "Calibrate";
      renderCalibration(lastMode);
    });
    el.calibrate.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      calibrationTap(event.timeStamp);
    });
    el.nightInput.addEventListener("change", () => {
      settings.night = el.nightInput.checked;
      saveSettings(settings);
      root.classList.toggle("is-night", settings.night);
    });
    el.collapseButton.addEventListener("click", () => {
      settings.collapsed = !settings.collapsed;
      saveSettings(settings);
      applySettingsToControls();
      lastSystem = -1;
      pendingIdleScroll = true;
      if (state) {
        update(state);
      }
    });
    el.zoomIn.addEventListener("click", () => setZoom(settings.zoom + 0.1));
    el.zoomOut.addEventListener("click", () => setZoom(settings.zoom - 0.1));
    el.layoutSelect.addEventListener("change", () => {
      settings.layout = el.layoutSelect.value === "pages" ? "pages" : "scroll";
      saveSettings(settings);
      applyLayout();
    });
    el.pageTurnSelect.addEventListener("change", () => {
      settings.pageTurn = el.pageTurnSelect.value === "whole" ? "whole" : "half";
      saveSettings(settings);
      requestDraw();
    });
    el.readingLineSelect.addEventListener("change", () => {
      const value = el.readingLineSelect.value;
      settings.readingLine = value === "top" || value === "middle" ? value : "upper";
      saveSettings(settings);
      lastSystem = -1;
      pendingIdleScroll = true;
      requestDraw();
    });
    el.leadInput.addEventListener("change", () => {
      const value = Math.round(Number(el.leadInput.value));
      settings.leadMs = Number.isFinite(value) ? Math.max(-500, Math.min(1000, value)) : 0;
      el.leadInput.value = String(settings.leadMs);
      saveSettings(settings);
      requestDraw();
    });
    el.follow.addEventListener("click", () => {
      followPausedUntil = 0;
      manualPage = undefined;
      lastSystem = -1;
      requestDraw();
    });

    // A finger or wheel on the score means the player wants to look around:
    // stop following for a few seconds. Programmatic scrolling fires none of these.
    for (const type of ["wheel", "touchstart", "pointerdown"]) {
      el.scroller.addEventListener(type, () => {
        if ((lastMode === "running" || lastMode === "countdown") && settings.layout === "scroll") {
          followPausedUntil = Date.now() + FOLLOW_PAUSE_MS;
          scrollAnimation = undefined;
          requestDraw();
          setTimeout(requestDraw, FOLLOW_PAUSE_MS + 50);
        }
      }, { passive: true });
    }

    // Swipe sideways to turn pages in page mode.
    el.scroller.addEventListener("pointerdown", (event) => {
      swipeStart = { x: event.clientX, y: event.clientY, at: performance.now() };
      swiped = false;
    }, { passive: true });
    el.scroller.addEventListener("pointerup", (event) => {
      const start = swipeStart;
      swipeStart = undefined;
      if (!start || settings.layout !== "pages" || picking) {
        return;
      }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5 && performance.now() - start.at < 800) {
        swiped = true;
        turnPages(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    // Tap the left or right edge to turn pages (page mode, any time) or to
    // scroll (scroll mode, while nothing plays). The host picking a start bar
    // taps the bar instead.
    el.scroller.addEventListener("click", (event) => {
      if (!loaded) {
        return;
      }
      if (picking) {
        pickAt(event);
        return;
      }
      if (swiped) {
        swiped = false;
        return;
      }
      const bounds = el.scroller.getBoundingClientRect();
      const side = (event.clientX - bounds.left) / bounds.width;
      const direction = side < 0.3 ? -1 : side > 0.7 ? 1 : 0;
      if (!direction) {
        return;
      }
      if (settings.layout === "pages") {
        turnPages(direction);
      } else if (lastMode !== "running" && lastMode !== "countdown") {
        el.scroller.scrollBy({ top: direction * el.scroller.clientHeight * 0.85, behavior: "smooth" });
      }
    });

    document.addEventListener("visibilitychange", () => {
      lastSystem = -1;
      requestDraw();
    });
    document.addEventListener("keydown", (event) => {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, select, textarea");
      if (calibration !== undefined && event.key === " " && !typing) {
        event.preventDefault();
        calibrationTap(event.timeStamp);
        return;
      }
      if ((event.key === "c" || event.key === "C") && !typing && !event.ctrlKey && !event.metaKey && !event.altKey && loaded && !root.hidden) {
        el.styleButton.click();
        return;
      }
      if (event.key === "Escape" && calibration !== undefined) {
        el.calibrateButton.click();
      } else if (event.key === "Escape" && picking) {
        setPicking(false);
      } else if (event.key === "Escape" && document.body.classList.contains("score-focus")) {
        setFocus(false);
      } else if (settings.layout === "pages" && document.body.classList.contains("score-focus") &&
          (event.key === "ArrowRight" || event.key === "PageDown" || event.key === "ArrowLeft" || event.key === "PageUp")) {
        // Page-turn pedals send these keys.
        turnPages(event.key === "ArrowRight" || event.key === "PageDown" ? 1 : -1);
      }
    });
  }

  /**
   * @param {string} songId
   * @param {string} name
   */
  function rememberSongPart(songId, name) {
    delete settings.songParts[songId];
    settings.songParts[songId] = name;
    const ids = Object.keys(settings.songParts);
    for (const old of ids.slice(0, Math.max(0, ids.length - SONG_PART_LIMIT))) {
      delete settings.songParts[old];
    }
  }

  /** @param {string} partId */
  function switchPart(partId) {
    if (!loaded) {
      return;
    }
    const { scoreId, manifest } = loaded;
    const part = manifest.parts.find((candidate) => candidate.id === partId);
    if (!part) {
      return;
    }
    const reference = loaded.reference;
    void fetchTiming(scoreId, part.timing).then((timing) => {
      if (loaded?.scoreId === scoreId) {
        showScore(scoreId, manifest, part.id, timing, reference);
      }
    }).catch((error) => showMessage(`Could not load ${part.name}: ${error instanceof Error ? error.message : error}`));
  }

  /** @param {number} zoom */
  function setZoom(zoom) {
    settings.zoom = Math.round(Math.max(0.5, Math.min(2, zoom)) * 10) / 10;
    saveSettings(settings);
    applyLayout();
  }

  /**
   * What comes next in the set and whether its notes are ready, so a missing
   * export shows up before the song is called, not when it starts.
   *
   * @param {RoomState} next
   */
  function renderNextSong(next) {
    const songs = next.setlist.songs;
    const index = songs.findIndex((song) => song.id === next.currentSong?.song?.id);
    const upcoming = index >= 0 ? songs[index + 1] : undefined;
    el.next.hidden = !upcoming;
    if (!upcoming) {
      el.next.textContent = "";
      return;
    }
    const score = next.setlistScores?.find((candidate) => candidate.songId === upcoming.id);
    const chosen = resolveScoreSource(score, preferredPart(), settings.source);
    const status = chosen
      ? "notes ready"
      : score?.status === "exporting" || score?.imports?.some((entry) => entry.status === "exporting")
        ? "exporting notes…"
        : "no notes";
    el.next.textContent = `Next: ${upcoming.title} · ${status}`;
    el.next.dataset.status = chosen ? "ready" : status === "no notes" ? "missing" : "exporting";
  }

  /**
   * Fetches the next MuseScore song's manifest, timing and pages ahead of time,
   * so a song change in the middle of a set never waits on the network.
   *
   * @param {RoomState} next
   */
  function preloadNextSong(next) {
    if (settings.collapsed) {
      return;
    }
    const songs = next.setlist.songs;
    const index = songs.findIndex((song) => song.id === next.currentSong?.song?.id);
    const scores = next.setlistScores ?? [];
    const upcomingSong = index >= 0
      ? songs.slice(index + 1).find((song) => resolveScoreSource(scores.find((score) => score.songId === song.id), settings.part, settings.source))
      : undefined;
    const upcoming = upcomingSong
      ? resolveScoreSource(scores.find((score) => score.songId === upcomingSong.id), settings.part, settings.source)
      : undefined;
    const partName = (upcomingSong && settings.songParts[upcomingSong.id]) || settings.part;
    const key = upcoming?.scoreId ? `${upcoming.scoreId}:${partName}:${settings.partIndex}:${settings.notation}` : "";
    if (!upcoming?.scoreId || key === preloadedKey) {
      return;
    }
    preloadedKey = key;
    const scoreId = upcoming.scoreId;
    void fetchManifest(scoreId).then(async (manifest) => {
      const partId = choosePart(manifest.parts, partName, settings.notation, settings.partIndex);
      const part = manifest.parts.find((candidate) => candidate.id === partId);
      if (!part) {
        return;
      }
      await fetchTiming(scoreId, part.timing);
      // The pages a song starts on; the rest load as the song gets to them.
      preloaded = part.pages.slice(0, 3).map((file) => {
        const image = new Image();
        image.decoding = "async";
        image.src = scoreFileUrl(scoreId, file);
        return image;
      });
    }).catch(() => {
      preloadedKey = "";
    });
  }

  /** @param {string} scoreId */
  async function fetchManifest(scoreId) {
    return cached(manifestCache, scoreId, () => fetchJson(scoreFileUrl(scoreId, "manifest.json")));
  }

  /**
   * @param {string} scoreId
   * @param {string} file
   */
  async function fetchTiming(scoreId, file) {
    const url = scoreFileUrl(scoreId, file);
    return cached(timingCache, url, () => fetchJson(url));
  }

  /**
   * @param {string} scoreId
   * @param {string} file
   */
  function scoreFileUrl(scoreId, file) {
    return `/api/scores/${encodeURIComponent(scoreId)}/${encodeURIComponent(file)}?token=${encodeURIComponent(token)}`;
  }

  return {
    update,
    setConnection,
    requestDraw,
    get preloadedPages() { return preloaded.length; },
    get cachedEntries() { return manifestCache.size + timingCache.size; }
  };
}

/**
 * A small least-recently-used cache of fetches: a failed fetch is forgotten,
 * and past CACHE_LIMIT entries the oldest goes.
 *
 * @template T
 * @param {Map<string, Promise<T>>} cache
 * @param {string} key
 * @param {() => Promise<T>} fetcher
 * @returns {Promise<T>}
 */
function cached(cache, key, fetcher) {
  let entry = cache.get(key);
  if (entry) {
    cache.delete(key);
  } else {
    entry = fetcher().catch((error) => {
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
      throw error;
    });
  }
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(/** @type {string} */ (cache.keys().next().value));
  }
  return entry;
}

function fullscreenElement() {
  const page = /** @type {any} */ (document);
  return page.fullscreenElement ?? page.webkitFullscreenElement;
}

async function exitFullscreen() {
  const page = /** @type {any} */ (document);
  try {
    await (page.exitFullscreen?.() ?? page.webkitExitFullscreen?.());
  } catch {
    // Already left.
  }
}

/** @param {string} url */
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/** @param {number} value */
function ordinal(value) {
  const suffix = value % 10 === 1 && value % 100 !== 11 ? "st"
    : value % 10 === 2 && value % 100 !== 12 ? "nd"
      : value % 10 === 3 && value % 100 !== 13 ? "rd"
        : "th";
  return `${value}${suffix}`;
}

/** @param {boolean} isHost */
function loadSettings(isHost) {
  const settings = { ...DEFAULT_SETTINGS, songParts: {}, songsterrStarts: {}, collapsed: isHost, focus: !isHost };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      if (typeof saved.part === "string") settings.part = saved.part.slice(0, 80);
      if (Number.isInteger(saved.partIndex) && saved.partIndex >= 0 && saved.partIndex < 32) settings.partIndex = saved.partIndex;
      if (saved.songParts && typeof saved.songParts === "object") {
        for (const [songId, name] of Object.entries(saved.songParts).slice(-SONG_PART_LIMIT)) {
          if (typeof name === "string") settings.songParts[songId.slice(0, 120)] = name.slice(0, 80);
        }
      }
      if (saved.notation === "notes" || saved.notation === "tab") settings.notation = saved.notation;
      if (saved.source === "musescore" || saved.source === "songsterr") settings.source = saved.source;
      if (Number.isFinite(saved.zoom)) settings.zoom = Math.max(0.5, Math.min(2, saved.zoom));
      if (saved.layout === "scroll" || saved.layout === "pages") settings.layout = saved.layout;
      if (saved.pageTurn === "half" || saved.pageTurn === "whole") settings.pageTurn = saved.pageTurn;
      if (saved.readingLine in READING_LINES) settings.readingLine = saved.readingLine;
      if (Number.isFinite(saved.leadMs)) settings.leadMs = Math.max(-500, Math.min(1000, Math.round(saved.leadMs)));
      // `motion` was "even" or "notes" before the cursor styles: both remain.
      if (CURSOR_STYLES.includes(saved.motion)) settings.motion = saved.motion;
      if (SCROLL_AHEAD_CHOICES.includes(saved.scrollAheadMs)) settings.scrollAheadMs = saved.scrollAheadMs;
      if (saved.songsterrStarts && typeof saved.songsterrStarts === "object") {
        for (const [songId, bar] of Object.entries(saved.songsterrStarts).slice(-SONG_PART_LIMIT)) {
          if (Number.isInteger(bar) && bar >= 1 && bar <= 5) settings.songsterrStarts[songId.slice(0, 120)] = bar;
        }
      }
      if (typeof saved.night === "boolean") settings.night = saved.night;
      // `notesFirst` replaced `focus`, whose default was off: older saved
      // values say nothing about what the player wants now.
      if (typeof saved.notesFirst === "boolean") settings.focus = saved.notesFirst;
      if (typeof saved[isHost ? "hostCollapsed" : "collapsed"] === "boolean") {
        settings.collapsed = saved[isHost ? "hostCollapsed" : "collapsed"];
      }
    }
  } catch {
    // Settings are a convenience; defaults work.
  }
  settings.focus = settings.focus && !isHost;
  /** @type {any} */ (settings).isHost = isHost;
  return settings;
}

/** @param {typeof DEFAULT_SETTINGS} settings */
function saveSettings(settings) {
  try {
    const isHost = Boolean(/** @type {any} */ (settings).isHost);
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      ...saved,
      part: settings.part,
      partIndex: settings.partIndex,
      songParts: settings.songParts,
      notation: settings.notation,
      source: settings.source,
      zoom: settings.zoom,
      layout: settings.layout,
      pageTurn: settings.pageTurn,
      readingLine: settings.readingLine,
      leadMs: settings.leadMs,
      motion: settings.motion,
      scrollAheadMs: settings.scrollAheadMs,
      songsterrStarts: settings.songsterrStarts,
      night: settings.night,
      ...(isHost ? { hostCollapsed: settings.collapsed } : { collapsed: settings.collapsed, notesFirst: settings.focus })
    }));
  } catch {
    // Keep running on in-memory settings.
  }
}
