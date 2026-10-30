// Keeps a music-stand screen from going dark mid-song.
//
// The Screen Wake Lock API is the clean way, but browsers only offer it to a
// secure context, and a coordinator on http://<LAN address> is not one. There
// the fallback is the old trick (NoSleep.js): a tiny muted video playing in a
// loop, which phones and tablets treat as "someone is watching". A video may
// only start from a tap, so until the first tap after it is wanted the caller
// is told to ask for one.

import { NO_SLEEP_VIDEOS } from "./no-sleep-video.js";

/**
 * @typedef {"lock" | "video" | "needs-tap" | "off"} KeepAwakeState
 *   lock: the Wake Lock holds; video: the fallback video plays; needs-tap:
 *   wanted, but the video waits for a tap; off: not wanted (or not possible).
 */

/**
 * @param {{ onChange?: (state: KeepAwakeState) => void }} [options]
 */
export function createKeepAwake({ onChange } = {}) {
  let wanted = false;
  /** @type {WakeLockSentinel | undefined} */
  let wakeLock;
  /** @type {HTMLVideoElement | undefined} */
  let video;
  /** @type {KeepAwakeState} */
  let state = "off";

  const api = /** @type {any} */ (navigator).wakeLock;
  const canLock = Boolean(api && window.isSecureContext);

  /** @param {KeepAwakeState} next */
  function setState(next) {
    if (next !== state) {
      state = next;
      onChange?.(state);
    }
  }

  function ensureVideo() {
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("muted", "");
      video.setAttribute("aria-hidden", "true");
      video.className = "keep-awake-video";
      for (const { type, src } of NO_SLEEP_VIDEOS) {
        const source = document.createElement("source");
        source.type = type;
        source.src = src;
        video.append(source);
      }
      document.body.append(video);
    }
    return video;
  }

  // Every sync supersedes the ones still waiting: a play() that our own pause()
  // interrupted must not report "needs a tap" after the screen was let go.
  let generation = 0;

  async function sync() {
    const run = ++generation;
    const active = wanted && document.visibilityState === "visible";
    if (!active) {
      if (wakeLock) {
        const sentinel = wakeLock;
        wakeLock = undefined;
        await sentinel.release().catch(() => undefined);
      }
      video?.pause();
      setState("off");
      return;
    }
    if (canLock) {
      try {
        if (!wakeLock) {
          const sentinel = await api.request("screen");
          if (run !== generation) {
            await sentinel.release().catch(() => undefined);
            return;
          }
          wakeLock = sentinel;
          sentinel.addEventListener("release", () => {
            if (wakeLock === sentinel) {
              wakeLock = undefined;
            }
          });
        }
        setState("lock");
        return;
      } catch {
        // Refused (low battery, policy): fall back to the video.
      }
    }
    const player = ensureVideo();
    if (!player.paused) {
      setState("video");
      return;
    }
    try {
      await player.play();
      if (run === generation) {
        setState("video");
      }
    } catch {
      if (run === generation) {
        setState("needs-tap");
      }
    }
  }

  // Any tap may start the video, and coming back to the page needs the lock
  // again (browsers drop it when the page is hidden).
  const retry = () => {
    if (wanted && state !== "lock" && state !== "video") {
      void sync();
    }
  };
  for (const type of ["pointerdown", "keydown", "touchend"]) {
    document.addEventListener(type, retry, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", () => void sync());

  return {
    /** @param {boolean} on */
    set(on) {
      if (on !== wanted) {
        wanted = on;
        void sync();
      }
    },
    get state() {
      return state;
    }
  };
}
