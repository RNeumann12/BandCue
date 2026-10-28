// Score view: the current MuseScore song's notes with a cursor that follows the
// room's downbeat, so any browser in the room (an iPad on a music stand, a
// laptop without MuseScore) can read along. It only ever reads: it never asks
// the room to play or stop, and it plays no audio.
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
  cursorAt,
  followScrollTop,
  resolvePlayhead,
  songTimeMs,
  startOffsetMs,
  systemsOf,
  visiblePages
} from "./score-timing.js";

/**
 * @typedef {import("../src/shared/protocol.js").RoomState} RoomState
 * @typedef {import("../src/shared/protocol.js").ScoreManifest} ScoreManifest
 * @typedef {import("../src/shared/protocol.js").ScoreTiming} ScoreTiming
 * @typedef {import("../src/shared/protocol.js").ScoreAvailability} ScoreAvailability
 */

const SETTINGS_KEY = "bandcue:score-view";
const READING_LINES = { top: 0.06, upper: 0.2, middle: 0.38 };
const FOLLOW_ANIMATION_MS = 420;
// How long a finger or wheel on the score holds off the automatic scrolling.
const FOLLOW_PAUSE_MS = 5_000;
// Cursor size in SVG units of the page (MuseScore pages are ~9924 wide).
const CURSOR_WIDTH = 64;
const CURSOR_OVERHANG = 70;

const DEFAULT_SETTINGS = {
  /** Name of the part this player reads, carried from song to song. */
  part: "",
  zoom: 1,
  /** "scroll" (one long column of pages) or "pages" (page turns). */
  layout: "scroll",
  /** @type {"top" | "upper" | "middle"} */
  readingLine: "upper",
  /** Shifts only this page's cursor, ms; positive runs ahead of the band. */
  leadMs: 0,
  focus: false,
  collapsed: false
};

/**
 * @param {{
 *   root: HTMLElement,
 *   token: string,
 *   isHost: boolean,
 *   roomNow: () => number | undefined
 * }} options
 */
export function createScoreView({ root, token, isHost, roomNow }) {
  const el = {
    title: /** @type {HTMLElement} */ (root.querySelector("#scoreTitle")),
    position: /** @type {HTMLElement} */ (root.querySelector("#scorePosition")),
    partSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scorePartSelect")),
    focusButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreFocusButton")),
    collapseButton: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreCollapseButton")),
    zoomOut: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreZoomOut")),
    zoomIn: /** @type {HTMLButtonElement} */ (root.querySelector("#scoreZoomIn")),
    zoomLabel: /** @type {HTMLElement} */ (root.querySelector("#scoreZoomLabel")),
    layoutSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scoreLayoutSelect")),
    readingLineSelect: /** @type {HTMLSelectElement} */ (root.querySelector("#scoreReadingLineSelect")),
    leadInput: /** @type {HTMLInputElement} */ (root.querySelector("#scoreLeadInput")),
    wakeHint: /** @type {HTMLElement} */ (root.querySelector("#scoreWakeHint")),
    connection: /** @type {HTMLElement} */ (root.querySelector("#scoreConnection")),
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
  /** @type {{ sequenceId: number, downbeatServerTime: number } | undefined} */
  let lastPlay;

  /** @type {{ scoreId: string, manifest: ScoreManifest, partId: string, timing: ScoreTiming, systems: ReturnType<typeof systemsOf>, pages: { el: HTMLElement, width: number, height: number }[] } | undefined} */
  let loaded;
  /** @type {string | undefined} the scoreId being loaded */
  let loadingScoreId;
  let loadError = "";
  let loadRetryAt = 0;

  const manifestCache = new Map();
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

  let frame = 0;
  let lastSystem = -1;
  let lastMode = "";
  let followPausedUntil = 0;
  /** @type {{ from: number, to: number, startedAt: number } | undefined} */
  let scrollAnimation;
  /** Page shown in page mode while nothing runs and the player turns pages by hand. */
  /** @type {number | undefined} */
  let manualPage;
  /** @type {WakeLockSentinel | undefined} */
  let wakeLock;

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
    }
    const transport = next.transport;
    if (transport.action === "play" && (transport.status === "scheduled" || transport.status === "running")) {
      const downbeat = transport.status === "running"
        ? transport.startedServerTime ?? transport.scheduledServerTime
        : transport.scheduledServerTime;
      if (downbeat !== undefined) {
        lastPlay = { sequenceId: transport.sequenceId, downbeatServerTime: downbeat };
      }
    }

    const score = next.currentScore;
    root.hidden = !score;
    document.body.classList.toggle("has-score", Boolean(score));
    if (!score) {
      setFocus(false, false);
      return;
    }
    el.title.textContent = song?.title ?? "";

    if (settings.collapsed) {
      // Folded away (the host page's default): fetch nothing until it is opened.
      showMessage("");
    } else if (score.status === "ready" && score.scoreId) {
      if (loaded?.scoreId !== score.scoreId && loadingScoreId !== score.scoreId && Date.now() >= loadRetryAt) {
        void load(score.scoreId);
      }
    } else {
      clearScore();
      showMessage(score.status === "exporting"
        ? "The MuseScore laptop is exporting the notes for this song…"
        : score.detail || "No notes for this song.");
    }
    preloadNextSong(next);
    requestDraw();
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
      const partId = choosePart(manifest.parts, settings.part) ?? manifest.parts[0]?.id;
      const part = manifest.parts.find((candidate) => candidate.id === partId);
      if (!part) {
        throw new Error("The export lists no parts.");
      }
      const timing = await fetchTiming(scoreId, part.timing);
      if (state?.currentScore?.scoreId !== scoreId) {
        return;
      }
      showScore(scoreId, manifest, part.id, timing);
      loadError = "";
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
      loadRetryAt = Date.now() + 3_000;
      showMessage(`Could not load the notes: ${loadError}`);
      setTimeout(() => state && update(state), 3_100);
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
      img.src = scoreFileUrl(scoreId, file);
      page.append(img);
      el.pages.append(page);
      return { el: page, width: size.width, height: size.height };
    });
    loaded = { scoreId, manifest, partId, timing, systems: systemsOf(timing), pages };

    el.partSelect.replaceChildren(...manifest.parts.map((candidate) => {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = candidate.name;
      option.selected = candidate.id === partId;
      return option;
    }));
    el.partSelect.disabled = manifest.parts.length < 2;
    showMessage("");
    lastSystem = -1;
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
    el.countdown.hidden = true;
  }

  /** @param {string} text */
  function showMessage(text) {
    el.message.textContent = text;
    el.message.hidden = !text;
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
    const playhead = resolvePlayhead(state.transport, lastPlay, now);
    const offset = startOffsetMs(loaded.timing, song?.startMeasure);
    let songMs = offset;
    if (synced !== undefined && playhead.downbeatServerTime !== undefined &&
        (playhead.mode === "running" || playhead.mode === "stopped")) {
      const at = playhead.mode === "stopped" ? Math.min(now, playhead.stoppedAtServerTime ?? now) : now;
      songMs = Math.max(offset, songTimeMs({
        roomNowMs: at,
        downbeatServerTime: playhead.downbeatServerTime,
        startOffsetMs: offset,
        tempoPercent: song?.tempoPercent,
        leadMs: playhead.mode === "running" ? settings.leadMs : 0
      }));
    }

    const position = cursorAt(loaded.timing, songMs);
    if (position) {
      placeCursor(position);
      const total = loaded.manifest.parts.find((part) => part.id === loaded?.partId)?.measureCount ?? 0;
      el.position.textContent = `Bar ${position.measureIndex + 1}${total ? ` / ${total}` : ""}` +
        (position.passNumber > 1 ? ` · ${ordinal(position.passNumber)} time` : "");
    }

    if (playhead.mode === "countdown") {
      el.countdown.hidden = false;
      el.countdown.textContent = synced === undefined
        ? "Syncing clock…"
        : `Starts in ${((playhead.remainingMs ?? 0) / 1000).toFixed(1)} s`;
    } else {
      el.countdown.hidden = true;
    }
    if (playhead.mode !== lastMode) {
      if (playhead.mode === "countdown") {
        // A new run: show its start, wherever the player had scrolled.
        followPausedUntil = 0;
        manualPage = undefined;
        lastSystem = -1;
      }
      lastMode = playhead.mode;
    }
    root.dataset.mode = playhead.mode;
    const following = playhead.mode === "running" || playhead.mode === "countdown";
    el.follow.hidden = !(following && Date.now() < followPausedUntil);

    if (position) {
      follow(position, following);
    }
    if (following || scrollAnimation) {
      frame = requestAnimationFrame(draw);
    }
  }

  /** @param {NonNullable<ReturnType<typeof cursorAt>>} position */
  function placeCursor(position) {
    const page = loaded?.pages[position.page];
    if (!page) {
      return;
    }
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
   * @param {NonNullable<ReturnType<typeof cursorAt>>} position
   * @param {boolean} following
   */
  function follow(position, following) {
    if (!loaded) {
      return;
    }
    if (settings.layout === "pages") {
      const shownPage = following || manualPage === undefined ? position.page : manualPage;
      showPages(shownPage);
      return;
    }

    const systemIndex = loaded.systems.systemOfMeasure[position.measureIndex] ?? 0;
    const paused = Date.now() < followPausedUntil;
    // Scroll on a new line (or a fresh layout); while nothing runs, only to
    // put a freshly loaded song's start in view.
    if (systemIndex !== lastSystem && !paused && (following || lastSystem === -1)) {
      lastSystem = systemIndex;
      const target = followTargetFor(systemIndex);
      if (target !== undefined) {
        scrollTo(target, following && lastMode === "running");
      }
    }
    keepCursorInViewHorizontally(position);
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
    if (scroller.scrollWidth <= scroller.clientWidth + 1 || !loaded || Date.now() < followPausedUntil) {
      return;
    }
    const page = loaded.pages[position.page];
    const x = page.el.offsetLeft + position.x * (page.el.clientWidth / page.width);
    if (x < scroller.scrollLeft + scroller.clientWidth * 0.1 || x > scroller.scrollLeft + scroller.clientWidth * 0.85) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * 0.3);
    }
  }

  /** @param {number} page */
  function showPages(page) {
    if (!loaded) {
      return;
    }
    const slots = el.scroller.clientWidth > el.scroller.clientHeight * 1.15 ? 2 : 1;
    const shown = visiblePages(page, loaded.pages.length, slots);
    loaded.pages.forEach((candidate, index) => {
      const position = shown.indexOf(index);
      candidate.el.classList.toggle("is-shown", position >= 0);
      candidate.el.style.order = String(Math.max(0, position));
    });
  }

  function applyLayout() {
    root.dataset.layout = settings.layout;
    el.pages.style.width = settings.layout === "scroll" ? `${Math.round(settings.zoom * 100)}%` : "";
    el.zoomLabel.textContent = `${Math.round(settings.zoom * 100)}%`;
    el.zoomIn.disabled = settings.layout !== "scroll" || settings.zoom >= 2;
    el.zoomOut.disabled = settings.layout !== "scroll" || settings.zoom <= 0.5;
    if (settings.layout === "scroll") {
      loaded?.pages.forEach((page) => {
        page.el.classList.remove("is-shown");
        page.el.style.order = "";
      });
    }
    lastSystem = -1;
    requestDraw();
  }

  /**
   * @param {boolean} on
   * @param {boolean} [remember]
   */
  function setFocus(on, remember = true) {
    document.body.classList.toggle("score-focus", on);
    el.focusButton.textContent = on ? "Exit notes only" : "Notes only";
    el.focusButton.setAttribute("aria-pressed", String(on));
    if (remember) {
      settings.focus = on;
      saveSettings(settings);
    }
    void syncWakeLock();
    lastSystem = -1;
    requestDraw();
  }

  // The Screen Wake Lock API needs a secure context, which a coordinator on
  // http://<LAN address> is not, so on most rehearsal setups the hint stays.
  async function syncWakeLock() {
    const wanted = document.body.classList.contains("score-focus") && document.visibilityState === "visible";
    const api = /** @type {any} */ (navigator).wakeLock;
    el.wakeHint.hidden = Boolean(api && window.isSecureContext);
    if (!api || !window.isSecureContext) {
      return;
    }
    try {
      if (wanted && !wakeLock) {
        wakeLock = await api.request("screen");
        wakeLock?.addEventListener("release", () => {
          wakeLock = undefined;
        });
      } else if (!wanted && wakeLock) {
        await wakeLock.release();
        wakeLock = undefined;
      }
    } catch {
      wakeLock = undefined;
    }
  }

  function applySettingsToControls() {
    el.layoutSelect.value = settings.layout;
    el.readingLineSelect.value = settings.readingLine;
    el.leadInput.value = String(settings.leadMs);
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
      const part = loaded.manifest.parts.find((candidate) => candidate.id === el.partSelect.value);
      if (!part) {
        return;
      }
      settings.part = part.id === "score" ? "" : part.name;
      saveSettings(settings);
      const { scoreId, manifest } = loaded;
      void fetchTiming(scoreId, part.timing).then((timing) => showScore(scoreId, manifest, part.id, timing))
        .catch((error) => showMessage(`Could not load ${part.name}: ${error instanceof Error ? error.message : error}`));
    });
    el.focusButton.addEventListener("click", () => setFocus(!document.body.classList.contains("score-focus")));
    el.collapseButton.addEventListener("click", () => {
      settings.collapsed = !settings.collapsed;
      saveSettings(settings);
      applySettingsToControls();
      lastSystem = -1;
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
    el.readingLineSelect.addEventListener("change", () => {
      const value = el.readingLineSelect.value;
      settings.readingLine = value === "top" || value === "middle" ? value : "upper";
      saveSettings(settings);
      lastSystem = -1;
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
      lastSystem = -1;
      requestDraw();
    });

    // A finger or wheel on the score means the player wants to look around:
    // stop following for a few seconds. Programmatic scrolling fires none of these.
    for (const type of ["wheel", "touchstart", "pointerdown"]) {
      el.scroller.addEventListener(type, () => {
        if (lastMode === "running" || lastMode === "countdown") {
          followPausedUntil = Date.now() + FOLLOW_PAUSE_MS;
          scrollAnimation = undefined;
          requestDraw();
          setTimeout(requestDraw, FOLLOW_PAUSE_MS + 50);
        }
      }, { passive: true });
    }

    // Tap the left or right edge to turn pages while nothing is playing.
    el.scroller.addEventListener("click", (event) => {
      if (!loaded || lastMode === "running" || lastMode === "countdown") {
        return;
      }
      const bounds = el.scroller.getBoundingClientRect();
      const side = (event.clientX - bounds.left) / bounds.width;
      const direction = side < 0.3 ? -1 : side > 0.7 ? 1 : 0;
      if (!direction) {
        return;
      }
      if (settings.layout === "pages") {
        const slots = el.scroller.clientWidth > el.scroller.clientHeight * 1.15 ? 2 : 1;
        const current = manualPage ?? Number(loaded.pages.find((page) => page.el.classList.contains("is-shown"))?.el.dataset.page ?? 0);
        manualPage = Math.max(0, Math.min(loaded.pages.length - 1, current + direction * slots));
        requestDraw();
      } else {
        el.scroller.scrollBy({ top: direction * el.scroller.clientHeight * 0.85, behavior: "smooth" });
      }
    });

    document.addEventListener("visibilitychange", () => {
      void syncWakeLock();
      lastSystem = -1;
      requestDraw();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && document.body.classList.contains("score-focus")) {
        setFocus(false);
      }
    });
  }

  /** @param {number} zoom */
  function setZoom(zoom) {
    settings.zoom = Math.round(Math.max(0.5, Math.min(2, zoom)) * 10) / 10;
    saveSettings(settings);
    applyLayout();
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
    const ready = (next.setlistScores ?? []).filter((score) => score.status === "ready" && score.scoreId);
    const upcoming = index >= 0
      ? songs.slice(index + 1).map((song) => ready.find((score) => score.songId === song.id)).find(Boolean)
      : undefined;
    const key = upcoming?.scoreId ? `${upcoming.scoreId}:${settings.part}` : "";
    if (!upcoming?.scoreId || key === preloadedKey) {
      return;
    }
    preloadedKey = key;
    const scoreId = upcoming.scoreId;
    void fetchManifest(scoreId).then(async (manifest) => {
      const part = manifest.parts.find((candidate) => candidate.id === choosePart(manifest.parts, settings.part));
      if (!part) {
        return;
      }
      await fetchTiming(scoreId, part.timing);
      preloaded = part.pages.map((file) => {
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
    if (!manifestCache.has(scoreId)) {
      manifestCache.set(scoreId, fetchJson(scoreFileUrl(scoreId, "manifest.json")).catch((error) => {
        manifestCache.delete(scoreId);
        throw error;
      }));
    }
    return /** @type {Promise<ScoreManifest>} */ (manifestCache.get(scoreId));
  }

  /**
   * @param {string} scoreId
   * @param {string} file
   */
  async function fetchTiming(scoreId, file) {
    const url = scoreFileUrl(scoreId, file);
    if (!timingCache.has(url)) {
      timingCache.set(url, fetchJson(url).catch((error) => {
        timingCache.delete(url);
        throw error;
      }));
    }
    return /** @type {Promise<ScoreTiming>} */ (timingCache.get(url));
  }

  /**
   * @param {string} scoreId
   * @param {string} file
   */
  function scoreFileUrl(scoreId, file) {
    return `/api/scores/${encodeURIComponent(scoreId)}/${encodeURIComponent(file)}?token=${encodeURIComponent(token)}`;
  }

  return { update, setConnection, requestDraw, get preloadedPages() { return preloaded.length; } };
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
  const settings = { ...DEFAULT_SETTINGS, collapsed: isHost };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      if (typeof saved.part === "string") settings.part = saved.part.slice(0, 80);
      if (Number.isFinite(saved.zoom)) settings.zoom = Math.max(0.5, Math.min(2, saved.zoom));
      if (saved.layout === "scroll" || saved.layout === "pages") settings.layout = saved.layout;
      if (saved.readingLine in READING_LINES) settings.readingLine = saved.readingLine;
      if (Number.isFinite(saved.leadMs)) settings.leadMs = Math.max(-500, Math.min(1000, Math.round(saved.leadMs)));
      if (typeof saved.focus === "boolean") settings.focus = saved.focus;
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
      zoom: settings.zoom,
      layout: settings.layout,
      readingLine: settings.readingLine,
      leadMs: settings.leadMs,
      ...(isHost ? { hostCollapsed: settings.collapsed } : { collapsed: settings.collapsed, focus: settings.focus })
    }));
  } catch {
    // Keep running on in-memory settings.
  }
}
