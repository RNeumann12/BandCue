let lastControlDetail = "Songsterr content script ready";
let statusTimer;
let statusReportTimer;
let durationObserver;
let lastObservedDurationMs;
let lastObservedSource = location.href;
const observedMediaElements = new WeakSet();

// Audio arming (iPadOS/iOS) -- see the section at the end of this file for what
// this is for. The state lives here because the bootstrap block below reads it.
const AUDIO_ARM_EVENTS = [
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
  "mousedown",
  "click",
  "keydown"
];
const AUDIO_ARMED_DETAIL = "BandCue audio is armed on this device";
const AUDIO_NOT_ARMED_DETAIL =
  "Audio is not armed on this device -- tap the Songsterr page once so BandCue can start playback";
let audioArmContext;
let audioArmed = false;
let audioArmOverlay;
let audioArmingInstalled = false;
// Forces the first setAudioArmed call through even though `false` is already the
// current value, so the very first status report carries the arm state.
let audioArmStateReported = false;

// The "audio, video" selector guarantees media elements, but querySelectorAll
// types them as bare Elements; centralize the JSDoc cast (tsconfig.web.json).
function queryMediaElements() {
  return /** @type {HTMLMediaElement[]} */ ([...document.querySelectorAll("audio, video")]);
}

function reportStatus() {
  if (location.href !== lastObservedSource) {
    lastObservedSource = location.href;
    lastObservedDurationMs = undefined;
    startDurationObservation();
  }
  observeDurationSources();
  if (audioArmingInstalled) {
    // Songsterr re-renders can drop the banner out of the DOM; put it back.
    syncAudioArmOverlay();
  }
  const durationMs = readSongDurationMs();
  lastObservedDurationMs = durationMs;
  if (durationMs !== undefined) {
    stopDurationObservation();
  } else {
    startDurationObservation();
  }
  sendRuntimeMessage({
    type: "songsterrStatus",
    ready: true,
    title: document.title,
    source: location.href,
    durationMs,
    detail: lastControlDetail
  });
}

function scheduleStatusReport(delayMs = 100, onlyWhenDurationChanges = false) {
  if (statusReportTimer) {
    if (onlyWhenDurationChanges) {
      return;
    }
    clearTimeout(statusReportTimer);
  }

  statusReportTimer = setTimeout(() => {
    statusReportTimer = undefined;
    if (onlyWhenDurationChanges && !hasDurationChanged()) {
      return;
    }
    reportStatus();
  }, delayMs);
}

function hasDurationChanged() {
  return readSongDurationMs() !== lastObservedDurationMs;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "bandcueReportStatus") {
    reportStatus();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "bandcueTransport") {
    runScheduledTransport(message).then((result) => {
      reportStatus();
      sendResponse(result);
    });
    return true;
  }

  if (message.type === "bandcueNavigateInPage") {
    navigateInPage(message.url).then(sendResponse);
    return true;
  }

  return false;
});

installAudioArming();
reportStatus();
statusTimer = setInterval(reportStatus, 5000);
startDurationObservation();
enforceSynthOnLoad();

function sendRuntimeMessage(message) {
  try {
    const response = chrome.runtime.sendMessage(message);
    if (response?.catch) {
      response.catch((error) => {
        handleRuntimeMessageError(error);
      });
    }
  } catch (error) {
    handleRuntimeMessageError(error);
  }
}

function handleRuntimeMessageError(error) {
  const message = error?.message || "";
  if (/extension context invalidated/i.test(message) && statusTimer) {
    clearInterval(statusTimer);
    statusTimer = undefined;
    if (statusReportTimer) {
      clearTimeout(statusReportTimer);
      statusReportTimer = undefined;
    }
    stopDurationObservation();
  }
}

// The background worker dispatches transport commands ahead of the scheduled
// downbeat and passes the target instant as dueLocalAt (already converted to
// this machine's clock, manual offset included). *All* of the work -- forcing
// the Synth source, resetting to the start, and deciding which control to
// touch -- happens here during the count-in, so the downbeat itself is a single
// click or key dispatch. Resolving the control on the beat (as this used to)
// cost two document-wide button scans with a forced layout each, measured at
// ~5 ms apiece on a real Songsterr page and scaling with DOM size and CPU --
// i.e. a per-device head start that no clock sync can compensate for.
async function runScheduledTransport(message) {
  const action = message.action;
  const resetBeforePlay = Boolean(message.resetBeforePlay);
  const dueLocalAt = Number(message.dueLocalAt) || 0;
  let prepared;
  // How much count-in was left once prep finished. Negative means the command
  // arrived too late to prep ahead at all, which the background uses to grow its
  // dispatch lead for later songs.
  let preparedAheadMs = dueLocalAt ? dueLocalAt - Date.now() : 0;
  if (dueLocalAt > Date.now()) {
    const prepStartedAt = Date.now();
    prepared = prepareTransport(action, resetBeforePlay);
    preparedAheadMs = dueLocalAt - Date.now();
    prepared.prepCostMs = Date.now() - prepStartedAt;
  }

  // Aim the wait early by however long the control action itself has been
  // taking, so the action *completes* on the downbeat rather than starting
  // there. The estimate is measured, not guessed (see recordActionCost).
  const aimMs = prepared ? actionCostEstimateMs : 0;
  const wakeLatenessMs = await waitUntilLocalTime(dueLocalAt - aimMs);
  const result = await controlSongsterr(action, resetBeforePlay, prepared);
  // Stamped after the control action has run, so it marks the moment playback
  // was actually triggered. The background converts this to server time for the
  // host's deviation view.
  result.firedAtLocal = Date.now();
  if (prepared) {
    recordActionCost(result.firedAtLocal - (dueLocalAt - aimMs + wakeLatenessMs));
  }
  result.timing = {
    deviationMs: dueLocalAt ? result.firedAtLocal - dueLocalAt : 0,
    wakeLatenessMs,
    prepCostMs: prepared?.prepCostMs ?? 0,
    preparedAheadMs,
    // Chrome clamps page timers in a hidden tab to >= 1 s, which no amount of
    // in-page scheduling can undo. Report it so the host can say why one member
    // starts late instead of leaving it a mystery.
    hidden: typeof document.visibilityState === "string" && document.visibilityState === "hidden"
  };
  return result;
}

// setTimeout alone can fire several ms late (far more when Chrome throttles a
// background tab), so sleep in self-correcting chunks -- each one re-reads the
// clock, so a single overlong wake-up can still be caught up -- and burn the
// last stretch in a tight loop.
const FINAL_SPIN_MS = 25;
const MAX_SLEEP_CHUNK_MS = 250;

// Rolling estimate of how long the control action takes once fired, used to aim
// the wait early. Seeded from a measurement on a real Songsterr page (a cold
// synthetic Space dispatch, including Songsterr's own synchronous play handler,
// took ~8 ms) and then adapted per device.
const DEFAULT_ACTION_COST_MS = 6;
// Never aim more than this far ahead: a single pathological sample (a GC pause,
// a background tab waking up) must not pull every later start noticeably early.
const MAX_ACTION_COST_MS = 60;
const ACTION_COST_SMOOTHING = 0.3;
let actionCostEstimateMs = DEFAULT_ACTION_COST_MS;

function recordActionCost(sampleMs) {
  if (!Number.isFinite(sampleMs) || sampleMs < 0) {
    return;
  }
  const bounded = Math.min(sampleMs, MAX_ACTION_COST_MS);
  actionCostEstimateMs += ACTION_COST_SMOOTHING * (bounded - actionCostEstimateMs);
}

/** Waits for the target instant; returns how late the wait actually woke up. */
async function waitUntilLocalTime(dueLocalAt) {
  if (!dueLocalAt) {
    return 0;
  }
  for (;;) {
    const remainingMs = dueLocalAt - Date.now() - FINAL_SPIN_MS;
    if (remainingMs <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(remainingMs, MAX_SLEEP_CHUNK_MS)));
  }
  while (Date.now() < dueLocalAt) {
    // Busy-wait for at most FINAL_SPIN_MS.
  }
  return Date.now() - dueLocalAt;
}

/**
 * Everything the downbeat needs, worked out ahead of time. Runs during the
 * count-in on the scheduled path, and inline (late, as before) when a command
 * arrives with no lead time left.
 */
function prepareTransport(action, resetBeforePlay) {
  // Songsterr's "Original" source streams a YouTube video, which can drift or
  // stall on a weak connection and break sync. The "Synth" source is rendered
  // locally, so force it before a synced play to keep playback deterministic.
  const synthDetail = action === "play" ? ensureSynthPlaybackMode() : "";
  const resetDetail = action === "play" && resetBeforePlay ? resetSongsterrPosition() : "";
  const mediaElements = queryMediaElements();
  const playbackState = inferPlaybackState(mediaElements);
  const control = resolveTransportControl(action, mediaElements, playbackState);
  if (control.kind === "space") {
    // Move focus now so the downbeat only has to dispatch the key events.
    primeKeyboardTarget();
  }
  // Settle style/layout while there is still time, so the click on the beat
  // doesn't trigger a synchronous recalc of everything the reset just dirtied.
  document.body?.getBoundingClientRect();
  return { synthDetail, resetDetail, playbackState, control };
}

/**
 * Picks the single control the downbeat will touch. Ordered exactly like the
 * old inline fallback chain, but resolved once, ahead of time.
 */
function resolveTransportControl(action, mediaElements, playbackState) {
  if (action === "stop" && playbackState === "stopped") {
    return { kind: "no-op" };
  }

  if (mediaElements.length) {
    return { kind: "media", mediaElements };
  }

  // Both remaining paths are toggles, so Stop must never use them unless we
  // could confirm playback is actually running -- toggling blind would start it.
  if (action === "stop" && playbackState === "unknown") {
    return { kind: "unconfirmed" };
  }

  const button = findTransportButton(action, playbackState);
  if (button) {
    return { kind: "button", element: button.element, label: button.label };
  }

  return action === "play" ? { kind: "space" } : { kind: "none" };
}

async function controlSongsterr(action, resetBeforePlay = false, prepared = undefined) {
  const plan = prepared ?? prepareTransport(action, resetBeforePlay);
  const { synthDetail, resetDetail, control } = plan;

  if (control.kind === "no-op") {
    lastControlDetail = "Songsterr playback is already stopped; Stop was a no-op";
    return { ok: true, detail: lastControlDetail, controlPath: "no-op" };
  }

  if (control.kind === "media") {
    const mediaResult = await controlMediaElement(action, control.mediaElements);
    if (mediaResult.ok) {
      lastControlDetail = joinControlDetails(
        synthDetail,
        resetDetail,
        `Used native media ${action}`,
        audioArmWarning(action)
      );
      return { ok: true, detail: lastControlDetail, controlPath: "media-element" };
    }
    // Rare: the media element refused. Re-resolve (late) rather than give up.
    const fallback = resolveTransportControl(action, [], plan.playbackState);
    if (fallback.kind === "button" || fallback.kind === "space") {
      return controlSongsterr(action, resetBeforePlay, { ...plan, control: fallback });
    }
    lastControlDetail = mediaResult.autoplayBlocked
      ? "Browser blocked autoplay for this tab. Click once inside the Songsterr tab, then try again."
      : `Could not find a Songsterr ${action} control`;
    return {
      ok: false,
      detail: lastControlDetail,
      controlPath: mediaResult.autoplayBlocked ? "autoplay-blocked" : "none"
    };
  }

  if (control.kind === "button") {
    // Songsterr re-renders its player, so the element resolved during the
    // count-in can be detached by the time the downbeat arrives. Re-resolving
    // costs a scan, but a stale click would silently do nothing at all.
    if (control.element.isConnected === false) {
      const fresh = resolveTransportControl(action, queryMediaElements(), inferPlaybackState());
      const usable = fresh.kind === "button" && fresh.element.isConnected === false
        ? { kind: "none" }
        : fresh;
      return controlSongsterr(action, resetBeforePlay, { ...plan, control: usable });
    }
    /** @type {HTMLElement} */ (control.element).click();
    lastControlDetail = joinControlDetails(
      synthDetail,
      resetDetail,
      `Clicked Songsterr player control: ${control.label}`,
      audioArmWarning(action)
    );
    return { ok: true, detail: lastControlDetail, controlPath: "player-button" };
  }

  if (control.kind === "space" && dispatchSpaceFallback()) {
    lastControlDetail = joinControlDetails(
      synthDetail,
      resetDetail,
      `Used safe Space shortcut fallback for ${action}`,
      audioArmWarning(action)
    );
    return { ok: true, detail: lastControlDetail, controlPath: "space-shortcut" };
  }

  lastControlDetail = control.kind === "unconfirmed"
    ? "Could not confirm Songsterr is playing; Stop did not use a toggle fallback"
    : `Could not find a Songsterr ${action} control`;
  return { ok: false, detail: lastControlDetail, controlPath: "none" };
}

function inferPlaybackState(mediaElements = queryMediaElements()) {
  if (mediaElements.some((media) => !media.paused && !media.ended)) {
    return "playing";
  }

  if (mediaElements.length) {
    return "stopped";
  }

  const visibleControls = [...document.querySelectorAll("button, [role='button']")]
    .filter(isVisible)
    .map(getControlLabel)
    .filter(Boolean);
  if (visibleControls.some((label) => /\b(pause|stop)\b/i.test(label))) {
    return "playing";
  }
  if (visibleControls.some((label) => /\b(play|resume|start)\b/i.test(label))) {
    return "stopped";
  }

  return "unknown";
}

function readSongDurationMs() {
  return readMediaDurationMs() || readVisibleDurationMs();
}

function readMediaDurationMs() {
  const durations = queryMediaElements()
    .map((media) => media.duration)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const durationSeconds = Math.max(0, ...durations);
  return durationSeconds > 0 ? Math.round(durationSeconds * 1000) : undefined;
}

function readVisibleDurationMs() {
  const durations = [...document.querySelectorAll("[aria-label], [aria-valuetext], [title], [role='slider'], time, span, div")]
    .filter(isVisible)
    .map(readDurationFromElement)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const durationSeconds = Math.max(0, ...durations);
  return durationSeconds > 0 ? Math.round(durationSeconds * 1000) : undefined;
}

function readDurationFromElement(element) {
  const text = [
    element.getAttribute("aria-valuetext"),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > 120) {
    return undefined;
  }

  const timeValues = parseTimeValues(text);
  if (timeValues.length) {
    const hasRangeSeparator = /(?:\/|\bof\b|\bout of\b|[-–—])/i.test(text);
    const namesDuration = /\b(duration|length|total|end)\b/i.test(text);
    if (timeValues.length >= 2 && hasRangeSeparator) {
      return Math.max(...timeValues);
    }
    if (timeValues.length === 1 && namesDuration) {
      return timeValues[0];
    }
  }

  const valueMax = Number(element.getAttribute("aria-valuemax"));
  if (
    Number.isFinite(valueMax) &&
    valueMax > 0 &&
    valueMax <= 24 * 60 * 60 &&
    /\b(duration|length|total|progress|timeline|seek)\b/i.test(text)
  ) {
    return valueMax;
  }

  return undefined;
}

function parseTimeValues(text) {
  return [...text.matchAll(/(?:\d{1,2}:)?\d{1,2}:\d{2}/g)]
    .map((match) => parseTimeValue(match[0]))
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0 && seconds <= 24 * 60 * 60);
}

function parseTimeValue(value) {
  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part))) {
    return undefined;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return seconds < 60 ? minutes * 60 + seconds : undefined;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : undefined;
  }

  return undefined;
}

function startDurationObservation() {
  observeDurationSources();
  if (
    lastObservedDurationMs !== undefined ||
    durationObserver ||
    typeof MutationObserver !== "function" ||
    !document.documentElement
  ) {
    return;
  }

  durationObserver = new MutationObserver(() => {
    scheduleStatusReport(250, true);
  });
  durationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-valuetext", "aria-valuemax", "title"]
  });
}

function stopDurationObservation() {
  if (!durationObserver) {
    return;
  }

  durationObserver.disconnect();
  durationObserver = undefined;
}

function observeDurationSources() {
  for (const media of queryMediaElements()) {
    if (observedMediaElements.has(media)) {
      continue;
    }

    observedMediaElements.add(media);
    media.addEventListener("loadedmetadata", () => scheduleStatusReport(0, true));
    media.addEventListener("durationchange", () => scheduleStatusReport(0, true));
    media.addEventListener("canplay", () => scheduleStatusReport(0, true));
  }
}

async function controlMediaElement(action, mediaElements = queryMediaElements()) {
  if (!mediaElements.length) {
    return { ok: false };
  }

  if (action === "play") {
    let autoplayBlocked = false;
    for (const media of mediaElements) {
      try {
        await media.play();
        return { ok: true };
      } catch (error) {
        // The browser refuses playback until the user has interacted with the
        // tab. Surface this specifically -- the button/Space fallbacks below
        // run through Songsterr's own JS and are blocked the same way.
        if (error?.name === "NotAllowedError") {
          autoplayBlocked = true;
        }
        // Try the next media element before falling back to Songsterr controls.
      }
    }
    return { ok: false, autoplayBlocked };
  }

  let pausedActiveMedia = false;
  for (const media of mediaElements) {
    if (!media.paused && !media.ended) {
      pausedActiveMedia = true;
    }
    media.pause();
  }

  return { ok: pausedActiveMedia };
}

function ensureSynthPlaybackMode() {
  const sourceControl = findSourceControl();
  if (!sourceControl) {
    return "";
  }

  const radios = [...sourceControl.querySelectorAll("input[type='radio'], [role='radio']")];
  const synthRadio = radios.find(isSynthSource);
  const originalRadio = radios.find(isOriginalSource);

  if (synthRadio && isRadioChecked(synthRadio)) {
    return "";
  }

  if (synthRadio) {
    activateSourceRadio(synthRadio);
    return "Forced Songsterr playback source to Synth";
  }

  // The Synth radio could not be identified by label. Only fall back to
  // Songsterr's "v" source toggle when we are confident the Original source is
  // currently active, so we never accidentally toggle away from Synth.
  const originalActive = (originalRadio && isRadioChecked(originalRadio)) || hasOriginalAudioSource();
  if (originalActive && dispatchKeyShortcut("v")) {
    return "Toggled Songsterr playback source toward Synth";
  }

  return "";
}

function findSourceControl() {
  return document.querySelector(
    ".control-source, #control-source, [class*='control-source'], [data-testid*='control-source']"
  );
}

function isSynthSource(radio) {
  return /\bsynth\b/.test(getSourceRadioLabel(radio));
}

function isOriginalSource(radio) {
  return /\boriginal\b/.test(getSourceRadioLabel(radio));
}

function getSourceRadioLabel(radio) {
  const labelledBy = (radio.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || "")
    .join(" ");

  return [
    radio.getAttribute("value"),
    radio.getAttribute("aria-label"),
    radio.getAttribute("title"),
    radio.getAttribute("name"),
    radio.id,
    labelledBy,
    findLabelFor(radio)?.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isRadioChecked(radio) {
  if (radio.getAttribute("aria-checked") !== null) {
    return radio.getAttribute("aria-checked") === "true";
  }
  return Boolean(radio.checked);
}

function activateSourceRadio(radio) {
  // Songsterr's source radios are often visually hidden inputs driven by an
  // associated label, so click the label when present and visible.
  const label = findLabelFor(radio);
  const target = label && isVisible(label) ? label : radio;
  target.click();
}

function findLabelFor(radio) {
  const wrapping = typeof radio.closest === "function" ? radio.closest("label") : null;
  if (wrapping) {
    return wrapping;
  }

  if (radio.id) {
    for (const label of document.querySelectorAll("label[for]")) {
      if (label.getAttribute("for") === radio.id) {
        return label;
      }
    }
  }

  return null;
}

function hasOriginalAudioSource() {
  return Boolean(
    document.querySelector("iframe[src*='youtube'], iframe[src*='youtu.be'], iframe[src*='ytimg']")
  );
}

function enforceSynthOnLoad(attemptsLeft = 12) {
  const detail = ensureSynthPlaybackMode();
  if (detail) {
    lastControlDetail = detail;
    scheduleStatusReport(0);
    return;
  }

  // Keep retrying briefly while the player is still mounting and the source
  // control has not rendered yet.
  if (!findSourceControl() && attemptsLeft > 0) {
    setTimeout(() => enforceSynthOnLoad(attemptsLeft - 1), 750);
  }
}

function resetSongsterrPosition() {
  // Songsterr drives its play cursor from internal state, not an HTML media
  // timeline, so currentTime = 0 alone does not move it. Backspace is
  // Songsterr's documented "go to the beginning" shortcut, so dispatch it
  // regardless of any incidental media elements on the page.
  const mediaElements = queryMediaElements();
  for (const media of mediaElements) {
    try {
      media.currentTime = 0;
    } catch {
      // Some embedded players expose media elements without a writable timeline.
    }
  }

  if (dispatchKeyShortcut("Backspace")) {
    return "Sent Backspace to move Songsterr to the song start";
  }

  return "Tried to reset Songsterr to the song start";
}

function findTransportButton(action, playbackState) {
  const words = action === "play"
    ? ["play", "resume", "start"]
    : ["pause", "stop"];
  const candidates = [...document.querySelectorAll("button, [role='button']")]
    .filter(isVisible)
    .map((element) => ({
      element,
      label: getControlLabel(element),
      score: scoreTransportCandidate(element, words)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (best) {
    return { element: best.element, label: best.label || best.element.tagName.toLowerCase() };
  }

  return findTransportToggleByClass(action, playbackState);
}

// Songsterr localizes every control label, so the English word list above finds
// nothing on, say, a German UI where Play reads "Abspielen" -- which silently
// pushed those devices onto the slower, blind Space-shortcut toggle. The player's
// transport button is a CSS-module class whose *local* name stays "play" in both
// states (e.g. "_8e144G_play"), so match that instead: it is language-independent
// and identifies the same element the user would click.
const TRANSPORT_TOGGLE_CLASS = /^(?:[A-Za-z0-9_-]+_)?play$/;

function findTransportToggleByClass(action, playbackState) {
  // The class identifies the toggle but not its direction, so only use it when
  // toggling actually moves playback the way we want.
  const wouldHelp = action === "play" ? playbackState !== "playing" : playbackState === "playing";
  if (!wouldHelp) {
    return undefined;
  }

  const toggle = [...document.querySelectorAll("button, [role='button']")]
    .filter(isVisible)
    .find((element) => classTokens(element).some((token) => TRANSPORT_TOGGLE_CLASS.test(token)));
  if (!toggle) {
    return undefined;
  }

  return {
    element: toggle,
    label: getControlLabel(toggle) || "player transport toggle"
  };
}

function classTokens(element) {
  const className = element.getAttribute("class") || "";
  return className.split(/\s+/).filter(Boolean);
}

// Focus work the Space fallback needs, hoisted out of the downbeat. Leaves the
// body focused and tabindex restored, exactly as dispatchKeyShortcut would.
function primeKeyboardTarget() {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
  if (!document.body) {
    return;
  }
  const previousTabIndex = document.body.getAttribute("tabindex");
  document.body.setAttribute("tabindex", "-1");
  document.body.focus({ preventScroll: true });
  if (previousTabIndex === null) {
    document.body.removeAttribute("tabindex");
  } else {
    document.body.setAttribute("tabindex", previousTabIndex);
  }
}

function scoreTransportCandidate(element, words) {
  const label = getControlLabel(element);
  const lowerLabel = label.toLowerCase();

  if (!label || /\b(tab|tabs|chord|favorite|print|settings|search|sign|login|upgrade)\b/i.test(label)) {
    return 0;
  }

  const exactWord = words.some((word) => lowerLabel === word);
  const containsWord = words.some((word) => new RegExp(`\\b${word}\\b`, "i").test(label));
  if (!exactWord && !containsWord) {
    return 0;
  }

  const rect = element.getBoundingClientRect();
  const lowerHalfBonus = rect.top > window.innerHeight * 0.35 ? 3 : 0;
  const buttonSizeBonus = rect.width >= 24 && rect.height >= 24 ? 2 : 0;
  const exactBonus = exactWord ? 10 : 4;

  return exactBonus + lowerHalfBonus + buttonSizeBonus;
}

function getControlLabel(element) {
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    element.textContent
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function dispatchSpaceFallback() {
  return dispatchKeyShortcut(" ");
}

function dispatchKeyShortcut(key) {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }

  if (!document.body) {
    return false;
  }

  const previousTabIndex = document.body.getAttribute("tabindex");
  document.body.setAttribute("tabindex", "-1");
  document.body.focus({ preventScroll: true });

  const isLetter = /^[a-z]$/i.test(key);
  const code = key === " "
    ? "Space"
    : isLetter
      ? `Key${key.toUpperCase()}`
      : key;
  const keyCode = key === " "
    ? 32
    : key === "Home"
      ? 36
      : key === "Backspace"
        ? 8
        : isLetter
          ? key.toUpperCase().charCodeAt(0)
          : 0;
  for (const target of [window, document, document.body]) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
    }
  }

  if (previousTabIndex === null) {
    document.body.removeAttribute("tabindex");
  } else {
    document.body.setAttribute("tabindex", previousTabIndex);
  }

  return true;
}

function joinControlDetails(...details) {
  return details.filter(Boolean).join("; ");
}

// --- In-page song switching -------------------------------------------------
// Songsterr is a single-page app: pushing the next song's path and firing a
// popstate makes its router swap songs inside the *same* document. Verified
// against the live player -- it routes on the "-s<id>" in the path, re-renders
// the transport control, and leaves an existing AudioContext running.
//
// That last part is the whole point. A real tab navigation tears the document
// down, and on iPadOS that takes the unlocked audio session with it (see the
// arming section below), so the member has to tap the screen again before
// playback makes any sound. Switching in place keeps the arm -- and it is
// quicker than a page load, so the tab is ready for the downbeat sooner.
//
// Songsterr could change its router at any time, so the result is *verified*
// before being reported as success; the background falls back to a full tab
// navigation whenever this returns not-ok.

const IN_PAGE_NAV_TIMEOUT_MS = 2500;
const IN_PAGE_NAV_POLL_MS = 50;

async function navigateInPage(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl, location.href);
  } catch {
    return { ok: false, detail: "Not a usable Songsterr URL" };
  }

  if (target.origin !== location.origin) {
    return { ok: false, detail: "In-page navigation cannot leave the current origin" };
  }

  if (target.pathname === location.pathname) {
    return { ok: true, detail: "Already on this Songsterr page" };
  }

  const previousHref = location.href;
  const previousTitle = document.title;
  try {
    history.pushState({}, "", `${target.pathname}${target.search}`);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  } catch {
    return { ok: false, detail: "Songsterr refused an in-page route change" };
  }

  if (!(await waitForTitleChange(previousTitle))) {
    // Put the address back so the caller's full navigation is not mistaken for
    // a tab that is already on the song.
    try {
      history.replaceState({}, "", previousHref);
    } catch {
      // Nothing further we can do; the caller reloads the tab either way.
    }
    return { ok: false, detail: "Songsterr did not pick up the in-page route change" };
  }

  // The document survived, so everything a reload would have rebuilt has to be
  // re-established by hand.
  lastObservedSource = location.href;
  lastObservedDurationMs = undefined;
  startDurationObservation();
  enforceSynthOnLoad();
  scheduleStatusReport(0);
  return { ok: true, detail: "Switched Songsterr song without reloading the page" };
}

/**
 * Songsterr retitles the document once its router has actually loaded the new
 * song, which is the cheapest honest proof that the route took -- the path alone
 * only proves we rewrote the address bar.
 */
function waitForTitleChange(previousTitle) {
  return new Promise((resolve) => {
    const deadline = Date.now() + IN_PAGE_NAV_TIMEOUT_MS;
    const poll = () => {
      if (document.title !== previousTitle) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, IN_PAGE_NAV_POLL_MS);
    };
    poll();
  });
}

// --- Audio arming (iPadOS/iOS) ---------------------------------------------
// WebKit only lets an AudioContext start or resume from inside a *trusted* user
// gesture, and it re-imposes that restriction on every new document. Chrome does
// not: one real click anywhere grants the page sticky activation, which is why
// synthetic clicks drive Songsterr fine on desktop.
//
// Songsterr's Synth source is Web Audio, so on an iPad the consequence is a
// silent failure that looks like success: after BandCue navigates the tab to the
// next song, the fresh document has no audio permission, our synthetic click
// still reaches Songsterr's handler (the button flips to Pause) and its context
// stays suspended -- no sound, and the cursor never moves.
//
// Nothing here can manufacture a gesture, so we ride along on any real touch the
// player makes: sounding one silent frame inside a trusted event clears WebKit's
// per-document restriction for the rest of that document's life, after which our
// synthetic click can resume Songsterr's own context. A banner asks for that tap
// while it is still missing, and the arm state is reported to the host so a dark
// iPad is visible *before* the count-in rather than after.
//
// None of this touches the downbeat path: arming runs on the user's tap, and the
// transport code only reads a boolean.

// State for this section lives with the other module state at the top of the
// file, because the bootstrap block reads it before this point.

/**
 * True only on the browsers that gate Web Audio behind a live user gesture per
 * document: WebKit on a touch device. Orion on iPadOS reports the desktop Safari
 * user agent, so the touch-point count -- not an "iPad" string match -- is what
 * identifies it. Chromium and desktop Safari never pay for any of this.
 */
function needsAudioArming() {
  const runtimeNavigator = globalThis.navigator;
  if (!runtimeNavigator || typeof audioContextConstructor() !== "function") {
    return false;
  }

  const userAgent = runtimeNavigator.userAgent || "";
  const isWebKit = /AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent);
  const isTouch =
    (runtimeNavigator.maxTouchPoints || 0) > 1 || /iPad|iPhone|iPod/.test(userAgent);
  return isWebKit && isTouch;
}

function audioContextConstructor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext;
}

function installAudioArming() {
  if (audioArmingInstalled || typeof document.addEventListener !== "function" || !needsAudioArming()) {
    return;
  }

  audioArmingInstalled = true;
  for (const type of AUDIO_ARM_EVENTS) {
    // Passive so the listeners can never delay a scroll or a tap, and capture so
    // they see the gesture even if Songsterr stops it from bubbling.
    document.addEventListener(type, handleArmingGesture, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", handleAudioArmVisibilityChange);
  setAudioArmed(false);
}

function handleArmingGesture(event) {
  // Our own Space/Backspace shortcuts dispatch untrusted KeyboardEvents; those
  // do not unlock anything, so they must not be mistaken for a real gesture.
  if (audioArmed || event?.isTrusted === false) {
    return;
  }

  armAudio();
}

function armAudio() {
  const AudioContextConstructor = audioContextConstructor();
  if (typeof AudioContextConstructor !== "function") {
    return;
  }

  try {
    // Constructed inside the gesture, so WebKit starts it running rather than
    // suspended, and kept afterwards so the unlocked session is never torn down.
    audioArmContext = audioArmContext || new AudioContextConstructor();
    audioArmContext.onstatechange = refreshAudioArmState;
    // Actually *sounding* a sample -- silent, one frame -- is what clears the
    // per-document restriction; resume() on its own can leave it in place.
    const source = audioArmContext.createBufferSource();
    source.buffer = audioArmContext.createBuffer(1, 1, audioArmContext.sampleRate);
    source.connect(audioArmContext.destination);
    source.start(0);
    const resumed = audioArmContext.resume();
    if (resumed?.then) {
      resumed.then(refreshAudioArmState, refreshAudioArmState);
    }
  } catch {
    // A browser that refuses to build the context simply stays unarmed, and the
    // banner keeps asking.
  }

  refreshAudioArmState();
}

function refreshAudioArmState() {
  setAudioArmed(audioArmContext?.state === "running");
}

// iOS suspends the context when the tab is backgrounded or the screen locks.
// Coming back may be enough to resume it (the restriction was already lifted for
// this document); if it is not, the state read below re-raises the banner.
function handleAudioArmVisibilityChange() {
  if (document.visibilityState !== "visible" || !audioArmContext) {
    return;
  }

  const resumed = audioArmContext.resume?.();
  if (resumed?.then) {
    resumed.then(refreshAudioArmState, refreshAudioArmState);
    return;
  }

  refreshAudioArmState();
}

function setAudioArmed(next) {
  if (audioArmed === next && audioArmStateReported) {
    return;
  }

  audioArmed = next;
  audioArmStateReported = true;
  lastControlDetail = next ? AUDIO_ARMED_DETAIL : AUDIO_NOT_ARMED_DETAIL;
  syncAudioArmOverlay();
  scheduleStatusReport(0);
}

/**
 * Shows/hides the "tap once" banner. Cheap and idempotent: it is also called
 * from the 5 s status tick so a Songsterr re-render that drops the node puts it
 * back. Never called from the transport path.
 */
function syncAudioArmOverlay() {
  if (audioArmed) {
    audioArmOverlay?.remove();
    audioArmOverlay = undefined;
    return;
  }

  if (audioArmOverlay?.isConnected || typeof document.createElement !== "function" || !document.body) {
    return;
  }

  const overlay = document.createElement("div");
  // A plain div on purpose: findTransportButton scans `button, [role='button']`,
  // and the wording avoids every transport word scoreTransportCandidate matches,
  // so the banner can never be mistaken for the player control. position:fixed
  // keeps it out of Songsterr's layout.
  overlay.textContent = "Tap to enable BandCue audio on this device";
  overlay.setAttribute("style", [
    "position:fixed",
    "left:50%",
    "bottom:16px",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "padding:14px 22px",
    "border-radius:999px",
    "background:#1f6feb",
    "color:#fff",
    "font:600 15px/1.2 system-ui,-apple-system,sans-serif",
    "box-shadow:0 4px 16px rgba(0,0,0,0.35)",
    "cursor:pointer",
    "touch-action:manipulation",
    "-webkit-user-select:none",
    "user-select:none"
  ].join(";"));
  document.body.appendChild(overlay);
  audioArmOverlay = overlay;
}

/**
 * Note for the host when a play is about to "succeed" visibly but stay silent.
 * Two boolean reads, so it costs the downbeat nothing.
 */
function audioArmWarning(action) {
  return action === "play" && audioArmingInstalled && !audioArmed ? AUDIO_NOT_ARMED_DETAIL : "";
}
