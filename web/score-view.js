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
  choosePart,
  countInBeat,
  countInState,
  cursorAt,
  familyIndexOf,
  followScrollTop,
  instrumentsOf,
  jumpAfter,
  measureAtPoint,
  partInNotation,
  playOfSong,
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
  /** @type {"even" | "notes"} how the cursor crosses a measure (see cursorAt) */
  motion: "even",
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

  /** @type {{ scoreId: string, manifest: ScoreManifest, partId: string, timing: ScoreTiming, systems: ReturnType<typeof systemsOf>, pages: { el: HTMLElement, img: HTMLImageElement, width: number, height: number }[] } | undefined} */
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

  let frame = 0;
  let lastSystem = -1;
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
      if (resolveScoreSource(state?.currentScore, preferredPart(), settings.source)?.scoreId !== scoreId) {
        return;
      }
      showScore(scoreId, manifest, part.id, timing);
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
   * @param {string} scoreId
   * @param {ScoreManifest} manifest
   * @param {string} partId
   * @param {ScoreTiming} timing
   */
  function showScore(scoreId, manifest, partId, timing) {
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
    loaded = { scoreId, manifest, partId, timing, systems: systemsOf(timing), pages };

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

  function draw() {
    frame = 0;
    if (!loaded || !state || root.hidden) {
      return;
    }
    const synced = roomNow();
    const now = synced ?? Date.now();
    const song = state.currentSong?.song;
    const playhead = resolvePlayhead(state.transport, lastPlay, now, song?.id);
    // The run's own start and tempo when the room says what they were (the
    // host may edit the song while it plays); else the song's.
    const run = playhead.play && "startMeasure" in playhead.play ? playhead.play : song;
    const offset = startOffsetMs(loaded.timing, run?.startMeasure);
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
        leadMs: settings.leadMs
      }));
    }

    const position = cursorAt(loaded.timing, songMs, { motion: settings.motion });
    if (position) {
      placeCursor(position);
      const total = loaded.manifest.parts.find((part) => part.id === loaded?.partId)?.measureCount ?? 0;
      const section = sectionAt(loaded.timing, position.measureIndex);
      el.position.textContent = `Bar ${position.measureIndex + 1}${total ? ` / ${total}` : ""}` +
        (section ? ` · ${section}` : "") +
        (position.passNumber > 1 ? ` · ${ordinal(position.passNumber)} time` : "");
      // Where the music goes next when it does not just carry on: shown on the
      // whole measure before a repeat or jump, so it is never a surprise.
      const jump = jumpAfter(loaded.timing.events, position.passIndex);
      el.jump.hidden = !jump;
      if (jump) {
        el.jump.textContent = jump.kind === "repeat" ? `↻ back to bar ${jump.toMeasureIndex + 1}` : `→ jump to bar ${jump.toMeasureIndex + 1}`;
      }
      measureMark.classList.toggle("is-before-jump", Boolean(jump));
    }

    renderCountdown(playhead, run);
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
    const following = playhead.mode === "running" || playhead.mode === "countdown";
    el.follow.hidden = !(following && Date.now() < followPausedUntil);
    el.pickStartButton.disabled = following;

    if (position) {
      follow(position, following);
    }
    if (following || scrollAnimation) {
      frame = requestAnimationFrame(draw);
    }
  }

  /**
   * @param {ReturnType<typeof resolvePlayhead>} playhead
   * @param {{ startMeasure?: number, tempoPercent?: number } | undefined} run
   */
  function renderCountdown(playhead, run) {
    beatFlash.classList.remove("is-on");
    if (playhead.mode === "elsewhere") {
      el.countdown.hidden = false;
      el.countdown.classList.remove("is-beat");
      el.countdown.textContent = "Band is on another song";
      return;
    }
    if (playhead.mode !== "countdown" || !loaded) {
      el.countdown.hidden = true;
      return;
    }
    el.countdown.hidden = false;
    if (roomNow() === undefined) {
      el.countdown.classList.remove("is-beat");
      el.countdown.textContent = "Syncing clock…";
      return;
    }
    const remainingMs = playhead.remainingMs ?? 0;
    const beats = countInState(remainingMs, countInBeat(loaded.timing, run?.startMeasure, run?.tempoPercent));
    if (beats) {
      // The count-in in beats, flashing on each one -- in the bar and along the
      // top edge, never over the start measure.
      el.countdown.classList.add("is-beat");
      el.countdown.textContent = `Count-in ${beats.beatsLeft}`;
      beatFlash.classList.toggle("is-on", beats.phase < 0.22);
    } else {
      el.countdown.classList.remove("is-beat");
      el.countdown.textContent = `Starts in ${(remainingMs / 1000).toFixed(1)} s`;
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
      page.el.append(measureMark, cursor);
    }
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
   */
  function follow(position, following) {
    if (!loaded) {
      return;
    }
    const paused = Date.now() < followPausedUntil;
    if (settings.layout === "pages") {
      const byHand = manualPage !== undefined && (!following || paused);
      showPages(byHand ? /** @type {number} */ (manualPage) : position.page);
      pendingIdleScroll = false;
      return;
    }

    const systemIndex = loaded.systems.systemOfMeasure[position.measureIndex] ?? 0;
    // Scroll on a new line (or a fresh layout) while the song runs; while
    // nothing runs, only when asked to (a new song, zoom, layout) -- never
    // because the window changed size.
    const wanted = following ? systemIndex !== lastSystem : pendingIdleScroll;
    if (wanted && !paused) {
      lastSystem = systemIndex;
      pendingIdleScroll = false;
      const target = followTargetFor(systemIndex);
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
    setPicking(false);
    onPickStart(measureIndex + 1);
    announce(`Start bar set to ${measureIndex + 1}.`);
  }

  function applySettingsToControls() {
    el.layoutSelect.value = settings.layout;
    el.pageTurnSelect.value = settings.pageTurn;
    el.readingLineSelect.value = settings.readingLine;
    el.leadInput.value = String(settings.leadMs);
    el.motionSelect.value = settings.motion;
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
      settings.motion = el.motionSelect.value === "notes" ? "notes" : "even";
      saveSettings(settings);
      requestDraw();
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
      if (event.key === "Escape" && picking) {
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
    void fetchTiming(scoreId, part.timing).then((timing) => {
      if (loaded?.scoreId === scoreId) {
        showScore(scoreId, manifest, part.id, timing);
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
  const settings = { ...DEFAULT_SETTINGS, songParts: {}, collapsed: isHost, focus: !isHost };
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
      if (saved.motion === "even" || saved.motion === "notes") settings.motion = saved.motion;
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
      night: settings.night,
      ...(isHost ? { hostCollapsed: settings.collapsed } : { collapsed: settings.collapsed, notesFirst: settings.focus })
    }));
  } catch {
    // Keep running on in-memory settings.
  }
}
