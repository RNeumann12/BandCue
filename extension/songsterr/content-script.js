let lastControlDetail = "Songsterr content script ready";
let statusTimer;
let statusReportTimer;
let durationObserver;
let lastObservedDurationMs;
let lastObservedSource = location.href;
/** @type {{ requestedPercent: number, appliedPercent?: number, state: string, detail: string }} */
let tempoStatus = { requestedPercent: 100, appliedPercent: 100, state: "applied", detail: "100% tempo" };
const observedMediaElements = new WeakSet();
// Songsterr's desktop speed ruler does not expose a native range input. These
// are the exact stops produced by its current ruler implementation (the eight
// labelled presets with two evenly spaced stops between each pair).
const SONGSTERR_DESKTOP_SPEEDS = [
  15, 18, 22, 25, 33, 42, 50, 58, 67, 75, 83, 92, 100, 108, 117, 125, 133, 142, 150, 158, 167, 175
];

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
// Gestures that *end* a tap. Both WebKit's audio unlock and Songsterr's own
// transport are at their most reliable inside these, and every tap produces one,
// so the priming cycle rides on them rather than on pointerdown.
const AUDIO_PRIME_EVENTS = new Set(["pointerup", "touchend", "click", "keydown"]);
const AUDIO_READY_DETAIL = "BandCue audio is armed and the Songsterr player is primed on this device";
const AUDIO_NOT_ARMED_DETAIL =
  "Audio is not armed on this device -- tap the Songsterr page once so BandCue can start playback";
const AUDIO_NOT_PRIMED_DETAIL =
  "Songsterr's own audio engine is not started on this device -- tap the Songsterr page once so BandCue can start playback";
const PLAYBACK_STALLED_DETAIL =
  "Songsterr took the start but the player never moved (silent start) -- tap the Songsterr page once";
let audioArmContext;
// Silent looping source held open so the audio session never goes idle; see
// startAudioArmKeepAlive.
let audioArmKeepAlive;
let audioArmed = false;
// Whether *this* world can build an AudioContext at all. False in Orion's
// content-script sandbox on iPadOS, where the priming half still works and is
// the half that matters; the arm then simply never gates readiness.
let audioArmSupported = false;
// Whether Songsterr's *own* audio engine has been started once on this page.
// Separate from audioArmed on purpose: our context being unlocked says nothing
// about the player's, which is the whole reason a member had to press Play/Stop
// by hand after every load. See the priming section at the end of this file.
let songsterrPrimed = false;
let primeStopTimer;
let primeVerifyTimer;
let postSwitchPrimeTimer;
// True from the moment a scheduled transport command arrives until it has fired,
// and (for play) until the matching stop. Priming must never touch the transport
// inside that window.
let transportCommandPending = false;
let bandcuePlaybackActive = false;
let audioArmOverlay;
let audioArmingInstalled = false;
// Forces the first readiness publish through even though `false` is already the
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
    // A song that ends by itself is never followed by a Stop command (the
    // players have already stopped), so this is where a finished play is
    // noticed. Without it, priming would stay blocked for the rest of the night
    // after the first song.
    if (bandcuePlaybackActive && inferPlaybackState() === "stopped") {
      bandcuePlaybackActive = false;
    }
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
    tempo: tempoStatus,
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

  if (message.type === "bandcueSetTempo") {
    setSongsterrTempo(message.tempoPercent).then((result) => {
      tempoStatus = result.ok
        ? { requestedPercent: result.requestedPercent, appliedPercent: result.appliedPercent, state: "applied", detail: result.detail }
        : { requestedPercent: result.requestedPercent, state: "failed", detail: result.detail };
      lastControlDetail = result.detail;
      reportStatus();
      sendResponse(result);
    }, (error) => {
      // Always answer. An unanswered transport message leaves the background
      // waiting on a promise that never settles, so the host would show the
      // command as pending forever instead of as the failure it was.
      lastControlDetail = `Songsterr ${message.action} failed: ${error?.message || error}`;
      sendResponse({ ok: false, detail: lastControlDetail, controlPath: "content-script-error" });
    });
    return true;
  }

  if (message.type === "bandcueTransport") {
    // Synchronously, before any awaiting: a priming play/stop cycle must never
    // still be running into a real downbeat.
    transportCommandPending = true;
    cancelAudioPrime();
    runScheduledTransport(message)
      // A command that throws must still clear the pending flag below -- leaving
      // it set would block audio priming for the rest of the session -- and the
      // background gets a reason instead of a channel that simply closes.
      .catch((error) => ({
        ok: false,
        detail: `Songsterr transport failed: ${error?.message || error}`,
        controlPath: "content-script"
      }))
      .then((result) => {
        transportCommandPending = false;
        reportStatus();
        sendResponse(result);
      });
    return true;
  }

  if (message.type === "bandcueNavigateInPage") {
    navigateInPage(message.url, message).then((result) => {
      // Reported twice on purpose: Safari-derived browsers (Orion on iPadOS --
      // the platform this path exists for) do not reliably hold an async
      // sendResponse channel open for as long as the router takes, and losing
      // the answer means falling back to the reload we are trying to avoid.
      // runtime.sendMessage is the channel status reports already use from
      // those devices; the background takes whichever arrives first.
      sendRuntimeMessage({
        type: "bandcueNavigateResult",
        // Echoed so the background can match this answer to the request it
        // belongs to; without it the answer is dropped and the switch degrades
        // to the reload this path exists to avoid.
        requestId: message.requestId,
        ok: result.ok,
        detail: result.detail
      });
      sendResponse(result);
    });
    return true;
  }

  return false;
});

async function setSongsterrTempo(value) {
  const requestedPercent = Math.max(15, Math.min(175, Math.round(Number(value) || 100)));
  if (readVisibleTempoPercent() === requestedPercent) {
    return { ok: true, requestedPercent, appliedPercent: requestedPercent, detail: `${requestedPercent}% tempo already selected` };
  }

  const speedControl = findSpeedControl();
  if (!speedControl) {
    return { ok: false, requestedPercent, detail: "Could not find Songsterr's playback speed control (Songsterr Plus may be required)." };
  }
  /** @type {HTMLElement} */ (speedControl).click();
  const speedDialog = await waitForSpeedDialog();
  if (!speedDialog) {
    return { ok: false, requestedPercent, detail: "Songsterr opened speed settings but the controls did not finish loading." };
  }

  const exactOption = [...speedDialog.querySelectorAll("button, [role='button'], [role='option']")]
    .find((element) => normalizedControlText(element) === `${requestedPercent}%`);
  if (exactOption) {
    /** @type {HTMLElement} */ (exactOption).click();
  } else {
    const slider = speedDialog.querySelector("[role='slider'][aria-valuenow]");
    if (slider) {
      const sliderResult = setSongsterrDesktopSlider(slider, requestedPercent);
      if (!sliderResult.ok) {
        return { ok: false, requestedPercent, detail: sliderResult.detail };
      }
    } else {
      const input = [...speedDialog.querySelectorAll("input")].find((candidate) => {
        const min = Number(candidate.min || 15);
        const max = Number(candidate.max || 175);
        return (candidate.type === "range" || candidate.type === "number") && min <= requestedPercent && max >= requestedPercent;
      });
      if (input) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        nativeSetter?.call(input, String(requestedPercent));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (!await setSongsterrCompactFineTempo(speedDialog, requestedPercent)) {
        return { ok: false, requestedPercent, detail: `Songsterr opened speed settings but exposed no control for ${requestedPercent}%.` };
      }
    }
  }

  const appliedPercent = await waitForTempoPercent(requestedPercent);
  return appliedPercent === requestedPercent
    ? { ok: true, requestedPercent, appliedPercent, detail: `${requestedPercent}% tempo applied through Songsterr controls` }
    : { ok: false, requestedPercent, detail: `Songsterr did not confirm ${requestedPercent}% tempo${appliedPercent ? ` (shows ${appliedPercent}%)` : ""}.` };
}

async function waitForSpeedDialog() {
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    const dialog = document.querySelector("[data-tab-control='speed'], [role='dialog'] [role='slider'][aria-valuenow]")
      ?.closest?.("[data-tab-control='speed'], [role='dialog']")
      ?? document.querySelector("[data-tab-control='speed']");
    if (dialog) return dialog;
    await delay(40);
  }
  return undefined;
}

function setSongsterrDesktopSlider(slider, requestedPercent) {
  const targetIndex = SONGSTERR_DESKTOP_SPEEDS.indexOf(requestedPercent);
  if (targetIndex < 0) {
    return {
      ok: false,
      detail: `${requestedPercent}% is not an exact Songsterr desktop speed stop. Use one of: ${SONGSTERR_DESKTOP_SPEEDS.join(", ")}%.`
    };
  }

  const ruler = slider.parentElement;
  const rect = ruler?.getBoundingClientRect?.();
  if (!ruler || !rect || rect.width <= 0) {
    return { ok: false, detail: "Songsterr's speed ruler is not visible." };
  }

  const ratio = targetIndex / (SONGSTERR_DESKTOP_SPEEDS.length - 1);
  const clientX = rect.left + rect.width * ratio;
  const clientY = rect.top + rect.height / 2;
  const usesPointerEvents = typeof PointerEvent === "function";
  const mouseInit = { bubbles: true, cancelable: true, buttons: 1, clientX, clientY };
  if (usesPointerEvents) {
    ruler.dispatchEvent(new PointerEvent("pointerdown", { ...mouseInit, pointerId: 1, pointerType: "mouse" }));
    document.dispatchEvent(new PointerEvent("pointerup", { ...mouseInit, buttons: 0, pointerId: 1, pointerType: "mouse" }));
  } else {
    ruler.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    document.dispatchEvent(new MouseEvent("mouseup", { ...mouseInit, buttons: 0 }));
  }
  return { ok: true };
}

async function setSongsterrCompactFineTempo(speedDialog, requestedPercent) {
  let current = readTempoPercentFrom(speedDialog);
  if (current === requestedPercent) return true;

  const fineTuning = [...speedDialog.querySelectorAll("button")]
    .find((button) => /fine tuning/i.test(button.getAttribute("aria-label") || "") || normalizedControlText(button) === "- | +");
  if (fineTuning) {
    /** @type {HTMLElement} */ (fineTuning).click();
    await delay(60);
  }

  current = readTempoPercentFrom(speedDialog);
  if (current === undefined) return false;
  const valueElement = [...speedDialog.querySelectorAll("*")]
    .find((element) => normalizedControlText(element) === `${current}%`);
  const fineSection = valueElement?.closest?.("section");
  const buttons = fineSection ? [...fineSection.querySelectorAll("button")] : [];
  if (buttons.length < 2) return false;

  const directionButton = requestedPercent < current ? buttons[0] : buttons[buttons.length - 1];
  const clickCount = Math.abs(requestedPercent - current);
  for (let click = 0; click < clickCount; click += 1) {
    /** @type {HTMLElement} */ (directionButton).click();
    // React must commit each one-percent state update before the next click;
    // otherwise batched synthetic clicks can all calculate from one stale value.
    await delay(12);
  }
  return true;
}

async function waitForTempoPercent(requestedPercent) {
  const deadline = Date.now() + 1500;
  let visible;
  while (Date.now() <= deadline) {
    visible = readVisibleTempoPercent();
    if (visible === requestedPercent) return visible;
    await delay(40);
  }
  return visible;
}

function findSpeedControl() {
  return document.querySelector("#c-speed button, #control-speed")
    ?? [...document.querySelectorAll("button, [role='button']")].find((element) => {
    const label = normalizedControlText(element);
    return /(?:playback\s*)?speed|tempo|\b\d{1,3}%/i.test(label);
  });
}

function readVisibleTempoPercent() {
  const slider = document.querySelector("[data-tab-control='speed'] [role='slider'][aria-valuenow]");
  if (slider && slider.getClientRects().length) {
    const value = Number(slider.getAttribute("aria-valuenow"));
    if (Number.isFinite(value)) return Math.round(value);
  }
  for (const element of document.querySelectorAll("button, [role='button'], output, [aria-label]")) {
    const match = normalizedControlText(element).match(/\b(\d{1,3})%/);
    if (match && element.getClientRects().length) return Number(match[1]);
  }
  return undefined;
}

function readTempoPercentFrom(root) {
  const slider = root.querySelector?.("[role='slider'][aria-valuenow]");
  if (slider) {
    const value = Number(slider.getAttribute("aria-valuenow"));
    if (Number.isFinite(value)) return Math.round(value);
  }
  for (const element of root.querySelectorAll?.("*") ?? []) {
    const match = normalizedControlText(element).match(/^(\d{1,3})%$/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function normalizedControlText(element) {
  return `${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("title") || ""} ${element.textContent || ""}`
    .replace(/\s+/g, " ").trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (message.action === "play") {
    const requestedTempo = Math.max(15, Math.min(175, Math.round(Number(message.tempoPercent) || 100)));
    if (tempoStatus.state !== "applied" || tempoStatus.appliedPercent !== requestedTempo) {
      return { ok: false, detail: `${requestedTempo}% tempo is not applied; open/load the song before Play.`, controlPath: "tempo-preflight" };
    }
  }
  const action = message.action;
  const resetBeforePlay = Boolean(message.resetBeforePlay);
  const dueLocalAt = Number(message.dueLocalAt) || 0;
  const startMeasure = Number(message.startMeasure) || 0;
  let prepared;
  // How much count-in was left once prep finished. Negative means the command
  // arrived too late to prep ahead at all, which the background uses to grow its
  // dispatch lead for later songs.
  let preparedAheadMs = dueLocalAt ? dueLocalAt - Date.now() : 0;
  if (dueLocalAt > Date.now()) {
    const prepStartedAt = Date.now();
    // The measure jump goes first: it is the only part of prep that has to wait
    // for Songsterr to answer, and the background hands this command over
    // correspondingly earlier (MEASURE_SEEK_LEAD_MS) so it stays clear of the
    // downbeat. Everything after it is the same synchronous prep as always.
    const seek = action === "play" && resetBeforePlay && startMeasure > 1
      ? await seekToMeasure(startMeasure, dueLocalAt)
      : undefined;
    prepared = prepareTransport(action, resetBeforePlay, startMeasure, seek);
    preparedAheadMs = dueLocalAt - Date.now();
    prepared.prepCostMs = Date.now() - prepStartedAt;
  }

  // Aim the wait early by however long the control action itself has been
  // taking, so the action *completes* on the downbeat rather than starting
  // there. The estimate is measured, not guessed (see recordActionCost).
  const aimMs = prepared ? actionCostEstimateMs : 0;
  const wakeLatenessMs = await waitUntilLocalTime(dueLocalAt - aimMs);
  const result = await controlSongsterr(action, resetBeforePlay, prepared, startMeasure);
  // Stamped after the control action has run, so it marks the moment playback
  // was actually triggered. The background converts this to server time for the
  // host's deviation view.
  result.firedAtLocal = Date.now();
  if (prepared) {
    recordActionCost(result.firedAtLocal - (dueLocalAt - aimMs + wakeLatenessMs));
  }
  if (action === "play") {
    bandcuePlaybackActive = result.ok;
    if (result.ok) {
      // Deliberately not awaited: the answer to the background must not wait on
      // a check that runs a second into the song.
      void verifyPlaybackProgress();
    }
  } else {
    bandcuePlaybackActive = false;
  }
  // Which measure this tab really started from (1 = the top), so the host can
  // flag a device that is about to play a different part of the song.
  result.startMeasure = action === "play" && resetBeforePlay ? result.startMeasure ?? 1 : undefined;
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
function prepareTransport(action, resetBeforePlay, startMeasure = 0, seek = undefined) {
  // Songsterr's "Original" source streams a YouTube video, which can drift or
  // stall on a weak connection and break sync. The "Synth" source is rendered
  // locally, so force it before a synced play to keep playback deterministic.
  const synthDetail = action === "play" ? ensureSynthPlaybackMode() : "";
  // A song that starts at a later measure has already been seeked there by the
  // caller (it needs to await Songsterr); everything else is unchanged, and a
  // song starting at the top still just rewinds.
  const wantsMeasure = action === "play" && resetBeforePlay && startMeasure > 1;
  // Only when a command arrived with no count-in left to await the seek in: one
  // click, unverified, rather than dropping the measure or delaying the start.
  const plannedSeek = seek ?? (wantsMeasure ? seekToMeasureInline(startMeasure) : undefined);
  const resetDetail = plannedSeek
    ? plannedSeek.detail
    : action === "play" && resetBeforePlay ? resetSongsterrPosition() : "";
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
  return { synthDetail, resetDetail, seek: plannedSeek, playbackState, control };
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

async function controlSongsterr(action, resetBeforePlay = false, prepared = undefined, startMeasure = 0) {
  const plan = prepared ?? prepareTransport(action, resetBeforePlay, startMeasure);
  const result = await applyTransportPlan(action, resetBeforePlay, plan);
  if (plan.seek) {
    // Carried out of every control path (including the late one that prepares
    // inline) so the background can report where this tab really started.
    result.startMeasure = plan.seek.reached;
  }
  return result;
}

async function applyTransportPlan(action, resetBeforePlay, plan) {
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

// --- Starting from a later measure -----------------------------------------
// Songsterr has no "go to measure N" shortcut (its documented keys are Space,
// Backspace to the top, and arrow keys that step note by note -- a step count
// that depends on the track's note density, so it cannot address a measure).
// What it does have is a click target: clicking inside a measure moves the play
// cursor there, and Space then plays from the cursor. So the seek is a click on
// the staff underneath that measure's number, verified against the play cursor.
//
// Both anchors are data attributes, not the hashed CSS-module class names
// Songsterr rebuilds on every deploy:
//   [data-tab-control="marker"] > text   the measure number, at the measure's
//                                        left edge on its staff line
//   use[href^="#cursor-playhead"]        the play cursor; one per staff line,
//                                        the visible one marks the position
const MEASURE_MARKER_SELECTOR = "[data-tab-control='marker'] text";
const PLAYHEAD_SELECTOR = "use[href^='#cursor-playhead']";
// How far below the measure number to click. The number sits just above its
// staff, so this lands inside the clickable staff area of that same measure.
const MEASURE_CLICK_OFFSET_Y = 40;
// Just right of the barline: Songsterr snaps the cursor to the nearest note, so
// this selects the measure's first note and nothing later. Measured across a
// normally drawn measure, every click from the barline to 40 px in produced the
// same first-beat position -- and starting there played a full measure before
// the cursor moved on, i.e. a real downbeat start.
//
// It is deliberately a *single* click. Songsterr also has a compressed
// rendering (repeated or empty measures drawn narrow), and there a click before
// the barline and one 30 px in select positions a whole measure apart with
// nothing in between: that measure has no position of its own to start from.
// Clicking further in until the cursor "looks right" therefore buys a start one
// measure late, silently. Reading the cursor back and reporting the measure it
// really reached is the honest answer, and the host warns about it.
const MEASURE_CLICK_OFFSET_X = 8;
// Songsterr renders the tab lazily, so a measure far down the song may not be
// in the DOM yet. Scroll toward it a bounded number of times before giving up.
const MEASURE_SCROLL_ATTEMPTS = 6;
// The seek runs early in the count-in and must be finished well before the
// downbeat's own approach; whatever is unresolved by then is reported, never
// chased into the start.
const SEEK_MARGIN_MS = 250;
const SEEK_BUDGET_MS = 700;
const SEEK_POLL_MS = 25;
const SEEK_SETTLE_POLLS = 4;

/**
 * Moves Songsterr's play cursor to the first beat of `measure` and reads the
 * cursor back to see where it really landed. Returns what the host needs to
 * know: which measure this tab will actually start from, and a human-readable
 * detail. Never throws and never blocks — a failed seek falls back to the top of
 * the song, exactly like a failed reset.
 */
async function seekToMeasure(measure, dueLocalAt = 0) {
  const marker = findMeasureMarker(measure);
  if (!marker) {
    return missingMeasureSeek(measure);
  }

  const deadline = Math.min(
    Date.now() + SEEK_BUDGET_MS,
    dueLocalAt ? dueLocalAt - SEEK_MARGIN_MS : Number.POSITIVE_INFINITY
  );
  const rect = marker.getBoundingClientRect();
  if (!clickStaffAt(rect.left + MEASURE_CLICK_OFFSET_X, rect.top + MEASURE_CLICK_OFFSET_Y)) {
    const resetDetail = resetSongsterrPosition();
    return {
      requested: measure,
      reached: 1,
      detail: `Measure ${measure} was not clickable in this Songsterr tab, so it started from the top (${resetDetail})`
    };
  }

  const observed = await settledPlayheadMeasure(deadline);
  if (observed === measure) {
    return {
      requested: measure,
      reached: measure,
      detail: `Moved the Songsterr cursor to measure ${measure}`
    };
  }

  if (observed === undefined) {
    return {
      requested: measure,
      reached: measure,
      detail: `Clicked measure ${measure} in Songsterr but could not read the cursor back to confirm it`
    };
  }

  return {
    requested: measure,
    reached: observed,
    detail: `Songsterr landed on measure ${observed} instead of measure ${measure}`
      + " (this tab draws that measure compressed, so it has no position of its own to start from)"
  };
}

/**
 * The one-click version, used only when a command reached this tab with no
 * count-in left to read the cursor back in. Better an unverified jump than a
 * start delayed by verification.
 */
function seekToMeasureInline(measure) {
  const marker = findMeasureMarker(measure);
  if (!marker) {
    return missingMeasureSeek(measure);
  }

  const rect = marker.getBoundingClientRect();
  return {
    requested: measure,
    reached: measure,
    detail: clickStaffAt(rect.left + MEASURE_CLICK_OFFSET_X, rect.top + MEASURE_CLICK_OFFSET_Y)
      ? `Clicked measure ${measure} in Songsterr with no count-in left to confirm it`
      : `Measure ${measure} was not clickable in this Songsterr tab`
  };
}

/** The answer for a measure this tab simply does not draw. */
function missingMeasureSeek(measure) {
  resetSongsterrPosition();
  return {
    requested: measure,
    reached: 1,
    detail: `Songsterr does not show measure ${measure} in this tab, so it started from the top`
      + " (repeated measures are drawn once, so a measure inside a repeat has no place to jump to)"
      + describeNearestMeasures(measure)
  };
}

/**
 * The measure the play cursor comes to rest in. Songsterr re-renders the cursor
 * a frame or two after the click, so this waits for the reading to stop moving
 * (about 50 ms in practice) rather than trusting the first sample.
 */
async function settledPlayheadMeasure(deadline) {
  let previous;
  for (let poll = 0; poll < SEEK_SETTLE_POLLS; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, SEEK_POLL_MS));
    const measure = playheadMeasure();
    if (measure !== undefined && measure === previous) {
      return measure;
    }
    previous = measure;
    if (Date.now() >= deadline) {
      break;
    }
  }
  return previous;
}

/**
 * The drawn measures on either side of one this tab does not show, so the host
 * can be told what it *can* start from instead of only what it can't.
 */
function describeNearestMeasures(measure) {
  const measures = measureMarkers().map((marker) => marker.measure);
  if (!measures.length) {
    return "";
  }

  const before = measures.filter((candidate) => candidate < measure);
  const after = measures.filter((candidate) => candidate > measure);
  const nearest = [
    before.length ? Math.max(...before) : undefined,
    after.length ? Math.min(...after) : undefined
  ].filter((candidate) => candidate !== undefined);
  return nearest.length ? `. This tab can start at ${nearest.join(" or ")}` : "";
}

/** The measure numbers Songsterr currently has rendered, with their elements. */
function measureMarkers() {
  return [...document.querySelectorAll(MEASURE_MARKER_SELECTOR)]
    .map((element) => ({ measure: Number((element.textContent || "").trim()), element }))
    .filter((marker) => Number.isInteger(marker.measure) && marker.measure > 0);
}

function findMeasureMarker(measure) {
  for (let attempt = 0; attempt <= MEASURE_SCROLL_ATTEMPTS; attempt += 1) {
    const markers = measureMarkers();
    const match = markers.find((marker) => marker.measure === measure);
    if (match) {
      scrollMeasureIntoView(match.element);
      // Re-read: the scroll above moves everything, and the click point is
      // taken from the element's rect right after this returns.
      return measureMarkers().find((marker) => marker.measure === measure)?.element ?? match.element;
    }

    if (!markers.length || !scrollTowardMeasure(markers, measure)) {
      return undefined;
    }
  }

  return undefined;
}

function scrollMeasureIntoView(element) {
  if (typeof element.scrollIntoView !== "function") {
    return;
  }
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || 0;
  // Songsterr's own header floats over the top of the page, so a measure near
  // the viewport edge is scrolled to the middle before it is clicked.
  if (rect.top < viewportHeight * 0.2 || rect.bottom > viewportHeight * 0.85) {
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  }
}

/** Scrolls toward an unrendered measure. Returns false when there is nowhere left to go. */
function scrollTowardMeasure(markers, measure) {
  const highest = Math.max(...markers.map((marker) => marker.measure));
  const lowest = Math.min(...markers.map((marker) => marker.measure));
  const target = measure > highest ? markers.find((marker) => marker.measure === highest)
    : measure < lowest ? markers.find((marker) => marker.measure === lowest)
      : undefined;
  if (!target || typeof target.element.scrollIntoView !== "function") {
    return false;
  }

  target.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  return true;
}

/** Which measure Songsterr's visible play cursor currently sits in. */
function playheadMeasure() {
  const playhead = [...document.querySelectorAll(PLAYHEAD_SELECTOR)]
    .find((element) => getComputedStyle(element).visibility !== "hidden");
  if (!playhead) {
    return undefined;
  }

  // Markers on the cursor's own staff line, found through the shared line <svg>
  // rather than by comparing coordinates.
  const line = typeof playhead.closest === "function" ? playhead.closest("svg") : null;
  const onLine = measureMarkers().filter(
    (marker) => (typeof marker.element.closest === "function" ? marker.element.closest("svg") : null) === line
  );
  if (!line || !onLine.length) {
    return undefined;
  }

  const cursorX = playhead.getBoundingClientRect().left;
  let current;
  for (const marker of onLine) {
    const markerX = marker.element.getBoundingClientRect().left;
    if (markerX <= cursorX && (!current || markerX > current.x)) {
      current = { measure: marker.measure, x: markerX };
    }
  }

  // Before the first labelled measure of the line (the clef/tuning column at
  // the start of a staff) the cursor still belongs to that first measure.
  return current?.measure ?? Math.min(...onLine.map((marker) => marker.measure));
}

/**
 * A full pointer/mouse sequence on whatever the tab draws at that point.
 * Songsterr's player reacts to plain bubbling events, so no user gesture is
 * involved — the same reason the synthetic Space/Backspace shortcuts already
 * work here. Returns false when there is nothing to click.
 */
function clickStaffAt(x, y) {
  const element = typeof document.elementFromPoint === "function"
    ? document.elementFromPoint(x, y)
    : undefined;
  if (!element) {
    return false;
  }

  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      detail: 1
    }));
  }
  return true;
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

async function navigateInPage(rawUrl, options = {}) {
  let target;
  try {
    target = new URL(rawUrl, location.href);
  } catch {
    return { ok: false, detail: "Not a usable Songsterr URL" };
  }

  if (target.origin !== location.origin) {
    return { ok: false, detail: "In-page navigation cannot leave the current origin" };
  }

  if (songsterrSongKey(target.pathname) === songsterrSongKey(location.pathname)) {
    return { ok: true, detail: "Already on this Songsterr song" };
  }

  const previousHref = location.href;
  const previousTitle = document.title;
  // Only once the switch is really going ahead: a redundant request for the song
  // we are already on must not throw away a re-prime scheduled by the switch
  // that put us here.
  cancelAudioPrime();
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
  // The arm survives the switch, but Songsterr rebuilt its player -- and with it
  // possibly the audio graph that has to be started once. Re-prime unless a
  // downbeat is already on its way (the background says so).
  if (options.allowAudioPrime !== false) {
    schedulePostSwitchAudioPrime();
  }
  scheduleStatusReport(0);
  return { ok: true, detail: "Switched Songsterr song without reloading the page" };
}

/**
 * Track-agnostic identity for a Songsterr song path. Songsterr canonicalizes its
 * address after loading -- it rewrites the whole slug from the song id, and
 * appends a per-track "t<n>" -- so the "-s<id>" is the only stable part. A raw
 * pathname comparison therefore says "different song" about the page we are
 * already on, and re-routing the player at the downbeat is exactly what this
 * whole path exists to avoid.
 * Keep in sync with songKeyFromPath() in background.js.
 */
function songsterrSongKey(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "").toLowerCase();
  const songId = path.match(/-s(\d+)(?:t\d+)?(?:\/|$)/)?.[1];
  return songId ? `s${songId}` : path;
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
// Arming our own context is necessary but *not sufficient*, which is why members
// still had to press Play and Stop by hand after every load before it worked:
// WebKit's start restriction is carried by each AudioContext, and Songsterr's is
// a different object from ours. Unlocking ours proves the gesture happened; only
// something that reaches Songsterr's own graph unlocks that. So the same gesture
// now also runs one play/stop cycle through Songsterr's own transport -- exactly
// the by-hand ritual, done for the member -- see the priming section below.
//
// None of this touches the downbeat path: arming and priming run on the user's
// tap or between songs, and the transport code only reads a boolean.

// State for this section lives with the other module state at the top of the
// file, because the bootstrap block reads it before this point.

/**
 * True only on the browsers that gate audio behind a live user gesture per
 * document: WebKit on a touch device. Orion on iPadOS reports the desktop Safari
 * user agent, so the touch-point count -- not an "iPad" string match -- is what
 * identifies it. Chromium and desktop Safari never pay for any of this.
 *
 * Deliberately says nothing about Web Audio. This used to require an
 * AudioContext in *our* world, which switched the whole feature off on the one
 * platform it exists for: Orion's content-script sandbox does not present the
 * constructor, so on a real iPad neither the banner nor the arming nor the
 * priming ever ran -- while the page itself gates audio exactly as assumed.
 * Priming is pure DOM and needs no Web Audio at all; only the arming half does,
 * and that half now switches itself off on its own (see audioArmSupported).
 */
function usesGestureGatedAudio() {
  const runtimeNavigator = globalThis.navigator;
  if (!runtimeNavigator) {
    return false;
  }

  return isApplePlatform(runtimeNavigator) && isTouchDevice(runtimeNavigator);
}

/**
 * Apple hardware, whatever the browser claims to *be*. The classic WebKit sniff
 * -- "AppleWebKit and not Chrome" -- is precisely wrong here: Orion hosts Chrome
 * extensions and presents a Chrome-flavoured user agent to them, so the one
 * browser this code exists for was the one it excluded. The Apple platform token
 * survives in those user agents, and together with a touch screen it identifies
 * an iPad/iPhone without asking which engine is drawing it. A desktop OS token
 * (Windows/Android/CrOS/Linux) is therefore not merely "not Apple" -- it is a
 * device with its own adapter, and stays out.
 */
function isApplePlatform(runtimeNavigator) {
  const signature = `${runtimeNavigator.userAgent || ""} ${
    runtimeNavigator.userAgentData?.platform || runtimeNavigator.platform || ""
  }`;
  return /iPad|iPhone|iPod|Macintosh|Mac OS X|macOS/i.test(signature);
}

function isTouchDevice(runtimeNavigator) {
  return (runtimeNavigator.maxTouchPoints || 0) > 0 || "ontouchstart" in globalThis;
}

function audioContextConstructor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext;
}

function installAudioArming() {
  if (audioArmingInstalled || typeof document.addEventListener !== "function") {
    return;
  }

  if (!usesGestureGatedAudio()) {
    // Nothing to install -- but say so once, because "the feature never ran" is
    // otherwise indistinguishable from "the feature ran and found nothing to do",
    // and telling those apart took a whole rehearsal once.
    lastControlDetail = describeSkippedAudioHandling();
    return;
  }

  audioArmingInstalled = true;
  audioArmSupported = typeof audioContextConstructor() === "function";
  for (const type of AUDIO_ARM_EVENTS) {
    // Passive so the listeners can never delay a scroll or a tap, and capture so
    // they see the gesture even if Songsterr stops it from bubbling.
    document.addEventListener(type, handleArmingGesture, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", handleAudioArmVisibilityChange);
  setAudioArmed(false);
}

/**
 * Why the gesture-gated audio handling is off, including the user agent that
 * decided it. Reported unconditionally and from the content script's own world,
 * because every wrong guess about this device so far was made from somewhere
 * else -- and "it never ran" was indistinguishable from "it ran and was happy"
 * for two releases.
 */
function describeSkippedAudioHandling() {
  const runtimeNavigator = globalThis.navigator;
  if (!runtimeNavigator) {
    return `${lastControlDetail}; gesture-gated audio handling off (no navigator)`;
  }

  const flags = [
    `apple=${isApplePlatform(runtimeNavigator) ? 1 : 0}`,
    `touch=${isTouchDevice(runtimeNavigator) ? 1 : 0}`,
    `touchPoints=${runtimeNavigator.maxTouchPoints || 0}`,
    `audioContext=${typeof audioContextConstructor() === "function" ? 1 : 0}`
  ].join(" ");
  const userAgent = String(runtimeNavigator.userAgent || "").slice(0, 90);
  return `${lastControlDetail}; gesture-gated audio handling off (${flags}) ua="${userAgent}"`;
}

function handleArmingGesture(event) {
  // Our own Space/Backspace shortcuts and priming clicks dispatch untrusted
  // events; those unlock nothing, so they must never be mistaken for a gesture.
  if (event?.isTrusted === false) {
    return;
  }

  if (audioArmSupported && !audioArmed) {
    armAudio();
  }

  // Priming has to happen *synchronously* inside this handler: it is the
  // document's live user activation that lets Songsterr's own context start, and
  // that is gone by the next task. Only on the events that end a tap, where
  // WebKit is most permissive -- a tap always produces one of them.
  if (AUDIO_PRIME_EVENTS.has(event?.type)) {
    primeSongsterrAudio(event);
  }
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
    startAudioArmKeepAlive();
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

/**
 * iPadOS takes an *idle* audio session away when the tab goes to the background
 * or the screen locks, and getting it back needs another gesture -- which is why
 * an iPad that sat through one song could be dark for the next. A session with a
 * source still running is far less likely to be reclaimed, so hold one open for
 * as long as the page lives: one second of silence, looped, through a gain of
 * zero. Inaudible, and cheap enough to leave running all night.
 */
function startAudioArmKeepAlive() {
  if (audioArmKeepAlive || typeof audioArmContext?.createGain !== "function") {
    return;
  }

  try {
    const gain = audioArmContext.createGain();
    gain.gain.value = 0;
    gain.connect(audioArmContext.destination);
    const source = audioArmContext.createBufferSource();
    const frames = Math.max(1, Math.round(audioArmContext.sampleRate) || 1);
    source.buffer = audioArmContext.createBuffer(1, frames, audioArmContext.sampleRate);
    source.loop = true;
    source.connect(gain);
    source.start(0);
    audioArmKeepAlive = source;
  } catch {
    // Without a keep-alive the arm simply behaves as it did before.
  }
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
  if (!next && audioArmSupported) {
    // The session went away, so whatever we did to Songsterr's engine went with
    // it: the next tap has to prime again. Only meaningful where we hold a
    // context of our own; without one, `false` is simply what it always is and
    // must not keep re-arming the banner.
    songsterrPrimed = false;
  }
  publishAudioReadiness();
}

function setSongsterrPrimed(next) {
  if (songsterrPrimed === next && audioArmStateReported) {
    return;
  }

  songsterrPrimed = next;
  publishAudioReadiness();
}

function publishAudioReadiness() {
  audioArmStateReported = true;
  lastControlDetail = audioReadinessDetail();
  syncAudioArmOverlay();
  scheduleStatusReport(0);
}

/** What the host is told about this device's audio, most blocking issue first. */
function audioReadinessDetail() {
  if (audioArmSupported && !audioArmed) {
    return AUDIO_NOT_ARMED_DETAIL;
  }

  const detail = songsterrPrimed ? AUDIO_READY_DETAIL : AUDIO_NOT_PRIMED_DETAIL;
  return audioArmSupported ? detail : `${detail} (priming only; no Web Audio in this context)`;
}

function isAudioReady() {
  return (audioArmed || !audioArmSupported) && songsterrPrimed;
}

/**
 * Shows/hides the "tap once" banner. Cheap and idempotent: it is also called
 * from the 5 s status tick so a Songsterr re-render that drops the node puts it
 * back. Never called from the transport path.
 */
function syncAudioArmOverlay() {
  if (isAudioReady()) {
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
  if (action !== "play" || !audioArmingInstalled || isAudioReady()) {
    return "";
  }

  return audioArmSupported && !audioArmed ? AUDIO_NOT_ARMED_DETAIL : AUDIO_NOT_PRIMED_DETAIL;
}

// --- Priming Songsterr's own audio engine (iPadOS/iOS) ----------------------
// The arming above unlocks *our* AudioContext. WebKit's start restriction is
// carried per context, though, and Songsterr's is not ours: a member could be
// armed and still dead silent, which is exactly the state where pressing Play
// and Stop once by hand -- after every load -- was the only thing that worked.
//
// So do that for them. Inside the same trusted gesture that arms us, start
// Songsterr through its own transport and stop it again a blink later: the start
// runs while the document's user activation is live, which is what lets
// Songsterr's context begin, and from then on our synthetic clicks drive a
// running engine. It is the member's own ritual, automated, and it costs one
// short blip of sound at the top of the song rather than a silent set.
//
// The rules this must never break:
//   * it never runs while a scheduled command is pending or a BandCue play is
//     under way (a stray tap must not stop the band);
//   * it never runs on the downbeat path -- only on a tap, or shortly after a
//     song switch when no play is on its way;
//   * it always leaves playback stopped and the cursor back at the start.

// How long the priming play is allowed to run. Long enough that Songsterr has
// really begun (and its context has really started), short enough to be a blip.
const AUDIO_PRIME_PLAY_MS = 140;
// Our own click is the only reason playback is running, so a stop that did not
// take has to be caught -- otherwise the blip becomes a song.
const AUDIO_PRIME_STOP_VERIFY_MS = 250;
// Time given to Songsterr's router to mount the new song before re-priming it.
const AUDIO_PRIME_AFTER_SWITCH_MS = 700;

/** Whether it is safe to touch the transport for reasons of our own right now. */
function canPrimeSongsterrAudio() {
  return audioArmingInstalled && !transportCommandPending && !bandcuePlaybackActive;
}

function primeSongsterrAudio(event) {
  if (songsterrPrimed || primeStopTimer || postSwitchPrimeTimer) {
    return;
  }

  // The member is pressing the player's own control: their gesture reaches
  // Songsterr directly, which is all priming was ever trying to arrange. Adding
  // a click of ours would only fight them.
  if (isTransportGestureTarget(event?.target)) {
    setSongsterrPrimed(true);
    return;
  }

  if (!canPrimeSongsterrAudio()) {
    return;
  }

  runAudioPrimeCycle();
}

function runAudioPrimeCycle() {
  const mediaElements = queryMediaElements();
  const playbackState = inferPlaybackState(mediaElements);
  if (playbackState === "playing") {
    // Sound is already coming out of this device; there is nothing left to
    // unlock, and stopping it is not ours to do.
    setSongsterrPrimed(true);
    return;
  }

  // Prime through the source the downbeat will play from -- that is the graph
  // that has to be started -- and while a gesture is still in force.
  ensureSynthPlaybackMode();
  if (!fireAudioPrimeControl(resolveTransportControl("play", mediaElements, playbackState))) {
    return;
  }

  primeStopTimer = setTimeout(() => finishAudioPrimeCycle(), AUDIO_PRIME_PLAY_MS);
}

/**
 * Starts playback the same way the downbeat would, but synchronously and without
 * touching any of the transport path's reporting state.
 */
function fireAudioPrimeControl(control) {
  if (control.kind === "media") {
    for (const media of control.mediaElements) {
      try {
        const started = media.play();
        started?.catch?.(() => undefined);
      } catch {
        // Fall through: the button/Space paths below are resolved separately.
      }
    }
    return true;
  }

  if (control.kind === "button" && control.element.isConnected !== false) {
    /** @type {HTMLElement} */ (control.element).click();
    return true;
  }

  if (control.kind === "space") {
    return dispatchSpaceFallback();
  }

  return false;
}

function finishAudioPrimeCycle(verify = true) {
  if (primeStopTimer) {
    clearTimeout(primeStopTimer);
    primeStopTimer = undefined;
  }

  stopPrimedPlayback();
  resetSongsterrPosition();
  setSongsterrPrimed(true);
  if (!verify) {
    return;
  }

  primeVerifyTimer = setTimeout(() => {
    primeVerifyTimer = undefined;
    if (inferPlaybackState() !== "playing") {
      return;
    }
    stopPrimedPlayback();
    resetSongsterrPosition();
  }, AUDIO_PRIME_STOP_VERIFY_MS);
}

function stopPrimedPlayback() {
  const mediaElements = queryMediaElements();
  // We started this playback ourselves a moment ago, so the usual "never toggle
  // blind on Stop" rule does not apply: an unconfirmed state is treated as
  // playing here, and only a *confirmed* stop is left alone.
  const state = inferPlaybackState(mediaElements) === "stopped" ? "stopped" : "playing";
  const control = resolveTransportControl("stop", mediaElements, state);
  if (control.kind === "media") {
    for (const media of control.mediaElements) {
      media.pause();
    }
    return;
  }

  if (control.kind === "button" && control.element.isConnected !== false) {
    /** @type {HTMLElement} */ (control.element).click();
  }
}

/**
 * Ends any priming in progress *now*, leaving playback stopped. Called the
 * moment a real command arrives, so a priming stop can never land inside it.
 */
function cancelAudioPrime() {
  if (postSwitchPrimeTimer) {
    clearTimeout(postSwitchPrimeTimer);
    postSwitchPrimeTimer = undefined;
  }
  if (primeVerifyTimer) {
    clearTimeout(primeVerifyTimer);
    primeVerifyTimer = undefined;
  }
  if (primeStopTimer) {
    finishAudioPrimeCycle(false);
  }
}

/**
 * An in-page song switch keeps the document -- and our arm -- but hands
 * Songsterr a rebuilt player, whose audio graph may be suspended again. Re-run
 * the cycle once the new song has mounted: where the document's unlock still
 * holds, this restores sound with no tap at all; where WebKit wants a fresh
 * gesture, the cycle is silent, the banner goes back up, and the host is told.
 */
function schedulePostSwitchAudioPrime() {
  if (!audioArmingInstalled) {
    return;
  }

  cancelAudioPrime();
  // Deliberately not published yet: the retry below normally restores it within
  // the second, and a banner that flashes between every song is its own problem.
  songsterrPrimed = false;
  postSwitchPrimeTimer = setTimeout(() => {
    postSwitchPrimeTimer = undefined;
    if (canPrimeSongsterrAudio()) {
      runAudioPrimeCycle();
      return;
    }
    publishAudioReadiness();
  }, AUDIO_PRIME_AFTER_SWITCH_MS);
}

function isTransportGestureTarget(target) {
  const element = typeof target?.closest === "function"
    ? target.closest("button, [role='button']")
    : undefined;
  if (!element) {
    return false;
  }

  return (
    classTokens(element).some((token) => TRANSPORT_TOGGLE_CLASS.test(token)) ||
    /\b(play|pause|stop|resume|start)\b/i.test(getControlLabel(element))
  );
}

// --- Did the start actually produce playback? -------------------------------
// A silent WebKit start looks like a success from every angle the transport path
// can see: the click lands, Songsterr's button flips to Pause, and the command
// is reported as succeeded. The only honest witness is whether the player
// actually moved, so look a second into the song and say so if it did not --
// which also puts the banner back and re-arms priming for the next tap.

const PLAYBACK_PROGRESS_CHECK_MS = 900;
// Narrow on purpose: this runs on a device already busy playing, so it must not
// be the document-wide scan the duration reader can afford at idle.
const PLAYBACK_PROGRESS_SELECTOR =
  "[aria-valuetext], [aria-valuenow], [role='slider'], time, [class*='time'], [class*='Time']";

async function verifyPlaybackProgress() {
  if (!audioArmingInstalled) {
    return;
  }

  const before = readPlaybackProgressSample();
  if (before === undefined) {
    // Nothing on this page reports a position, so there is no evidence either
    // way -- and a guess would be worse than silence.
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, PLAYBACK_PROGRESS_CHECK_MS));
  if (!bandcuePlaybackActive) {
    return;
  }

  const after = readPlaybackProgressSample();
  if (after === undefined || after !== before) {
    return;
  }

  setSongsterrPrimed(false);
  lastControlDetail = PLAYBACK_STALLED_DETAIL;
  scheduleStatusReport(0);
}

/**
 * A string that changes while playback is running, or undefined when this page
 * offers no such evidence.
 */
function readPlaybackProgressSample() {
  const running = queryMediaElements().filter((media) => !media.paused && !media.ended);
  if (running.length) {
    return running.map((media) => Math.round((Number(media.currentTime) || 0) * 100)).join("|");
  }

  const positions = [...document.querySelectorAll(PLAYBACK_PROGRESS_SELECTOR)]
    .filter(isVisible)
    .map(readProgressFromElement)
    .filter(Boolean);
  return positions.length ? positions.join("|") : undefined;
}

function readProgressFromElement(element) {
  const value = element.getAttribute("aria-valuenow");
  if (value && Number.isFinite(Number(value))) {
    return `v${value}`;
  }

  const text = [element.getAttribute("aria-valuetext"), element.textContent]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 120) {
    return "";
  }

  const times = parseTimeValues(text);
  return times.length ? `t${times.join(",")}` : "";
}
