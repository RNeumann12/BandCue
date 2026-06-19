let lastControlDetail = "Songsterr content script ready";

function reportStatus() {
  chrome.runtime.sendMessage({
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
    controlSongsterr(message.action).then((result) => {
      reportStatus();
      sendResponse(result);
    });
    return true;
  }

  return false;
});

reportStatus();
setInterval(reportStatus, 5000);

async function controlSongsterr(action) {
  const mediaControlled = await controlMediaElement(action);
  if (mediaControlled) {
    lastControlDetail = `Used native media ${action}`;
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "media-element"
    };
  }

  const clicked = clickTransportButton(action);
  if (clicked) {
    lastControlDetail = `Clicked Songsterr player control: ${clicked}`;
    return {
      ok: true,
      detail: lastControlDetail,
      controlPath: "player-button"
    };
  }

  if (dispatchSpaceFallback()) {
    lastControlDetail = `Used safe Space shortcut fallback for ${action}`;
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

  for (const target of [window, document, document.body]) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
      key: " ",
      code: "Space",
      keyCode: 32,
      which: 32,
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
