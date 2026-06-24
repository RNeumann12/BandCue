let lastControlDetail = "Songsterr content script ready";
let statusTimer;
let statusReportTimer;
let durationObserver;
let lastObservedDurationMs;
const observedMediaElements = new WeakSet();

function reportStatus() {
  observeDurationSources();
  const durationMs = readSongDurationMs();
  lastObservedDurationMs = durationMs;
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
    controlSongsterr(message.action, Boolean(message.resetBeforePlay)).then((result) => {
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
    if (durationObserver) {
      durationObserver.disconnect();
      durationObserver = undefined;
    }
  }
}

async function controlSongsterr(action, resetBeforePlay = false) {
  const resetDetail = action === "play" && resetBeforePlay
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

  const mediaControlled = await controlMediaElement(action);
  if (mediaControlled) {
    lastControlDetail = joinControlDetails(resetDetail, `Used native media ${action}`);
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
    lastControlDetail = joinControlDetails(resetDetail, `Clicked Songsterr player control: ${clicked}`);
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "player-button"
    };
  }

  if (action === "play" && dispatchSpaceFallback()) {
    lastControlDetail = joinControlDetails(resetDetail, `Used safe Space shortcut fallback for ${action}`);
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "space-shortcut"
    };
  }

  lastControlDetail = `Could not find a Songsterr ${action} control`;
  return {
    ok: false,
    detail: lastControlDetail,
    controlPath: "none"
  };
}

function inferPlaybackState() {
  const mediaElements = [...document.querySelectorAll("audio, video")];
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
  const durations = [...document.querySelectorAll("audio, video")]
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
  if (typeof MutationObserver !== "function" || !document.documentElement) {
    return;
  }

  durationObserver = new MutationObserver(() => {
    observeDurationSources();
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

function observeDurationSources() {
  for (const media of document.querySelectorAll("audio, video")) {
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
  const mediaElements = [...document.querySelectorAll("audio, video")];
  if (!mediaElements.length) {
    return false;
  }

  if (action === "play") {
    for (const media of mediaElements) {
      try {
        await media.play();
        return true;
      } catch {
        // Try the next media element before falling back to Songsterr controls.
      }
    }
    return false;
  }

  let pausedActiveMedia = false;
  for (const media of mediaElements) {
    if (!media.paused && !media.ended) {
      pausedActiveMedia = true;
    }
    media.pause();
  }

  return pausedActiveMedia;
}

function resetSongsterrPosition() {
  // Songsterr drives its play cursor from internal state, not an HTML media
  // timeline, so currentTime = 0 alone does not move it. Backspace is
  // Songsterr's documented "go to the beginning" shortcut, so dispatch it
  // regardless of any incidental media elements on the page.
  const mediaElements = [...document.querySelectorAll("audio, video")];
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

  best.element.click();
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

  const code = key === " " ? "Space" : key;
  const keyCode = key === " "
    ? 32
    : key === "Home"
      ? 36
      : key === "Backspace"
        ? 8
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
