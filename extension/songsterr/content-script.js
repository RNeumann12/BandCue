let lastControlDetail = "Songsterr content script ready";
let statusTimer;

function reportStatus() {
  sendRuntimeMessage({
    type: "songsterrStatus",
    ready: true,
    title: document.title,
    detail: lastControlDetail
  });
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
  }
}

async function controlSongsterr(action, resetBeforePlay = false) {
  const resetDetail = action === "play" && resetBeforePlay
    ? resetSongsterrPosition()
    : "";
  const mediaControlled = await controlMediaElement(action);
  if (mediaControlled) {
    lastControlDetail = joinControlDetails(resetDetail, `Used native media ${action}`);
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "media-element"
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

  if (dispatchSpaceFallback()) {
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
