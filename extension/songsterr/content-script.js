let lastControlDetail = "Songsterr content script ready";
let statusTimer;
let statusReportTimer;
let durationObserver;
let lastObservedDurationMs;
let lastObservedSource = location.href;
const observedMediaElements = new WeakSet();

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

  return false;
});

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
// this machine's clock, manual offset included). Songsterr prep (forcing the
// Synth source, resetting to the start) runs immediately during the count-in;
// the final wait happens here so the control action itself lands on the beat
// instead of after tab-query + messaging + prep latency.
async function runScheduledTransport(message) {
  const action = message.action;
  const resetBeforePlay = Boolean(message.resetBeforePlay);
  const dueLocalAt = Number(message.dueLocalAt) || 0;
  let prepared;
  if (action === "play" && dueLocalAt > Date.now()) {
    prepared = {
      synthDetail: ensureSynthPlaybackMode(),
      resetDetail: resetBeforePlay ? resetSongsterrPosition() : ""
    };
  }
  await waitUntilLocalTime(dueLocalAt);
  const result = await controlSongsterr(action, resetBeforePlay, prepared);
  // For play via the media element, media.play() has resolved here, i.e.
  // playback has actually begun -- the best local proxy for the audible start.
  // The background converts this to server time for the host's deviation view.
  result.firedAtLocal = Date.now();
  return result;
}

// setTimeout alone can fire several ms late (more under load), so sleep to just
// short of the target and burn the last stretch in a tight loop.
const FINAL_SPIN_MS = 25;

async function waitUntilLocalTime(dueLocalAt) {
  if (!dueLocalAt) {
    return;
  }
  const coarseMs = dueLocalAt - Date.now() - FINAL_SPIN_MS;
  if (coarseMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, coarseMs));
  }
  while (Date.now() < dueLocalAt) {
    // Busy-wait for at most FINAL_SPIN_MS.
  }
}

async function controlSongsterr(action, resetBeforePlay = false, prepared = undefined) {
  // Songsterr's "Original" source streams a YouTube video, which can drift or
  // stall on a weak connection and break sync. The "Synth" source is rendered
  // locally, so force it before a synced play to keep playback deterministic.
  // When the scheduled path already did this during the count-in, reuse its
  // result instead of repeating the DOM work on the downbeat.
  const synthDetail = prepared
    ? prepared.synthDetail
    : action === "play" ? ensureSynthPlaybackMode() : "";
  const resetDetail = prepared
    ? prepared.resetDetail
    : action === "play" && resetBeforePlay
      ? resetSongsterrPosition()
      : "";
  const playbackState = inferPlaybackState();
  if (action === "stop" && playbackState === "stopped") {
    lastControlDetail = "Songsterr playback is already stopped; Stop was a no-op";
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "no-op"
    };
  }

  const mediaResult = await controlMediaElement(action);
  if (mediaResult.ok) {
    lastControlDetail = joinControlDetails(synthDetail, resetDetail, `Used native media ${action}`);
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "media-element"
    };
  }

  if (action === "stop" && playbackState === "unknown") {
    lastControlDetail = "Could not confirm Songsterr is playing; Stop did not use a toggle fallback";
    return {
      ok: false,
      detail: lastControlDetail,
      controlPath: "none"
    };
  }

  const clicked = clickTransportButton(action);
  if (clicked) {
    lastControlDetail = joinControlDetails(synthDetail, resetDetail, `Clicked Songsterr player control: ${clicked}`);
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "player-button"
    };
  }

  if (action === "play" && dispatchSpaceFallback()) {
    lastControlDetail = joinControlDetails(synthDetail, resetDetail, `Used safe Space shortcut fallback for ${action}`);
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "space-shortcut"
    };
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

function inferPlaybackState() {
  const mediaElements = queryMediaElements();
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

async function controlMediaElement(action) {
  const mediaElements = queryMediaElements();
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

function clickTransportButton(action) {
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
  if (!best) {
    return "";
  }

  /** @type {HTMLElement} */ (best.element).click();
  return best.label || best.element.tagName.toLowerCase();
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
