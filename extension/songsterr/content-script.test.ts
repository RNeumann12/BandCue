import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const contentScriptSource = readFileSync(
  fileURLToPath(new URL("./content-script.js", import.meta.url)),
  "utf8"
);

class FakeElement {
  listeners: Record<string, Array<() => void>> = {};

  constructor(
    public textContent = "",
    private readonly attributes: Record<string, string> = {}
  ) {}

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  focus() {}

  blur() {}

  getBoundingClientRect() {
    return { width: 100, height: 20, top: 10 };
  }

  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  dispatched: string[] = [];

  dispatchEvent(event: { type?: string }) {
    this.dispatched.push(event?.type ?? "");
    return true;
  }

  emit(type: string) {
    for (const listener of this.listeners[type] ?? []) {
      listener();
    }
  }

  // Set by a test that needs a gesture target to resolve to a control.
  closestTarget: FakeElement | null = null;

  closest() {
    return this.closestTarget;
  }

  clicks = 0;

  click() {
    this.clicks += 1;
  }

  // Elements handed out by querySelectorAll stand for nodes already in the
  // document; createElement below hands back detached ones.
  isConnected = true;

  children: FakeElement[] = [];

  appendChild(child: FakeElement) {
    this.children.push(child);
    child.isConnected = true;
    return child;
  }

  remove() {
    this.isConnected = false;
  }
}

class FakeSourceControl {
  constructor(private readonly radios: FakeElement[]) {}

  querySelectorAll() {
    return this.radios;
  }
}

class FakeMediaElement extends FakeElement {
  duration = Number.NaN;
}

class FakeKeyboardEvent {
  constructor(public type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, init);
  }
}

// iPadOS reports the *desktop* Safari user agent (Orion included), so the
// content script identifies it by touch points rather than an "iPad" match.
const IPAD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

class FakeAudioContext {
  static created = 0;

  state = "suspended";
  sampleRate = 44_100;
  destination = {};
  onstatechange: (() => void) | undefined;
  // Counts silent frames actually sounded -- the step that clears WebKit's
  // per-document gesture restriction.
  sounded = 0;

  constructor() {
    FakeAudioContext.created += 1;
  }

  // Sources still running when the test looks -- the silent keep-alive that
  // stops iPadOS reclaiming an idle session.
  looping = 0;

  createBuffer() {
    return {};
  }

  createGain() {
    return { gain: { value: 1 }, connect: () => {} };
  }

  createBufferSource() {
    const source = {
      buffer: null,
      loop: false,
      connect: () => {},
      start: () => {
        this.sounded += 1;
        if (source.loop) {
          this.looping += 1;
        }
      }
    };
    return source;
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  suspendFromSystem() {
    this.state = "suspended";
    this.onstatechange?.();
  }
}

function loadContentScript({
  elements = [],
  media = [],
  sourceControl = null,
  ipad = false,
  // "spa" mimics Songsterr's real router: a popstate retitles the document once
  // the new song has loaded. "none" is a router that ignores the route change.
  router = "none"
}: {
  elements?: FakeElement[];
  media?: FakeMediaElement[];
  sourceControl?: FakeSourceControl | null;
  ipad?: boolean;
  router?: "spa" | "none";
} = {}) {
  const messages: unknown[] = [];
  // Counts the document-wide element scans, so a test can prove the downbeat
  // does no scanning of its own.
  const scans = { controlQueries: 0 };
  const documentListeners: Record<string, Array<(event: unknown) => void>> = {};
  const document = {
    title: "Song A Tab by Artist",
    documentElement: new FakeElement(),
    body: new FakeElement(),
    activeElement: null,
    visibilityState: "visible",
    addEventListener(type: string, listener: (event: unknown) => void) {
      (documentListeners[type] ??= []).push(listener);
    },
    createElement() {
      const created = new FakeElement();
      created.isConnected = false;
      return created;
    },
    querySelector(selector: string) {
      if (sourceControl && /control-source/.test(selector)) {
        return sourceControl;
      }
      return null;
    },
    getElementById() {
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "audio, video") {
        return media;
      }
      if (selector === "label[for]") {
        return [];
      }
      if (/button/.test(selector)) {
        scans.controlQueries += 1;
      }
      return elements;
    }
  };
  const chrome = {
    runtime: {
      // Kept so a test can drive the real handler the background talks to.
      onMessage: {
        listener: undefined as undefined | ((m: any, s: any, r: any) => unknown),
        addListener(fn: (m: any, s: any, r: any) => unknown) {
          chrome.runtime.onMessage.listener = fn;
        }
      },
      sendMessage(message: unknown) {
        messages.push(message);
      }
    }
  };
  let mutationObserver: FakeMutationObserver | undefined;
  class FakeMutationObserver {
    observed = false;
    disconnected = false;

    constructor() {
      mutationObserver = this;
    }

    observe() {
      this.observed = true;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const keyEvents: string[] = [];
  // Which keys were actually sent, so a test can tell a Space transport from the
  // Backspace that puts the cursor back at the start.
  const keysPressed: string[] = [];
  const recordKey = (event: { type?: string; key?: unknown }) => {
    if (event?.type === "keydown" && typeof event.key === "string") {
      keysPressed.push(event.key);
    }
  };
  let routedTitles = 0;
  const window = {
    innerHeight: 900,
    dispatchEvent(event: { type?: string; key?: unknown }) {
      keyEvents.push(event?.type ?? "");
      recordKey(event);
      if (event?.type === "popstate" && router === "spa") {
        routedTitles += 1;
        document.title = `Routed Song ${routedTitles} Tab by Artist`;
      }
      return true;
    }
  };
  (document as unknown as { dispatchEvent: (e: { type?: string; key?: unknown }) => boolean }).dispatchEvent = (event) => {
    keyEvents.push(event?.type ?? "");
    recordKey(event);
    return true;
  };

  const toLocation = (href: string) => {
    const url = new URL(href);
    return { href: url.toString(), origin: url.origin, pathname: url.pathname, search: url.search };
  };

  const context: any = {
    chrome,
    document,
    window,
    location: toLocation("https://www.songsterr.com/a/wsa/song-a-tab-s100"),
    // Only what navigateInPage touches; both entry points rewrite the address
    // the same way, which is what lets the failure path put it back.
    history: {
      pushState(_state: unknown, _title: string, url: string) {
        context.location = toLocation(new URL(url, context.location.href).toString());
      },
      replaceState(_state: unknown, _title: string, url: string) {
        context.location = toLocation(new URL(url, context.location.href).toString());
      }
    },
    URL,
    PopStateEvent: class {
      constructor(public type: string, init: Record<string, unknown> = {}) {
        Object.assign(this, init);
      }
    },
    MutationObserver: FakeMutationObserver,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    KeyboardEvent: FakeKeyboardEvent,
    HTMLElement: FakeElement,
    Number,
    Date,
    Promise,
    Math,
    RegExp,
    WeakSet
  };
  if (ipad) {
    FakeAudioContext.created = 0;
    context.navigator = { userAgent: IPAD_USER_AGENT, maxTouchPoints: 5 };
    context.AudioContext = FakeAudioContext;
  }

  vm.createContext(context);
  vm.runInContext(contentScriptSource, context);
  // `let` bindings live in the script's lexical scope, not on the context object,
  // so module-level state has to be read by evaluating in the same context.
  const evaluate = (expression: string) => vm.runInContext(expression, context);
  const fireGesture = (type: string, init: Record<string, unknown> = {}) => {
    for (const listener of documentListeners[type] ?? []) {
      listener({ type, isTrusted: true, ...init });
    }
  };
  const overlay = () => document.body.children[0];
  return {
    context,
    messages,
    mutationObserver,
    scans,
    keyEvents,
    evaluate,
    documentListeners,
    fireGesture,
    keysPressed,
    overlay
  };
}

describe("Songsterr content duration discovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses finite native media duration first", () => {
    const media = new FakeMediaElement();
    media.duration = 184.4;
    const { context } = loadContentScript({ media: [media] });

    expect(context.readSongDurationMs()).toBe(184_400);
  });

  it("falls back to a visible elapsed / total time label", () => {
    const { context } = loadContentScript({
      elements: [new FakeElement("0:00 / 3:04")]
    });

    expect(context.readSongDurationMs()).toBe(184_000);
  });

  it("reads labelled duration text without requiring an elapsed time", () => {
    const { context } = loadContentScript({
      elements: [new FakeElement("Duration 1:02:03")]
    });

    expect(context.readSongDurationMs()).toBe(3_723_000);
  });

  it("ignores a lone unlabeled time because it may be only elapsed position", () => {
    const { context } = loadContentScript({
      elements: [new FakeElement("3:04")]
    });

    expect(context.readSongDurationMs()).toBeUndefined();
  });

  it("reports again when media metadata changes", () => {
    vi.useFakeTimers();
    const media = new FakeMediaElement();
    const { messages } = loadContentScript({ media: [media] });

    media.duration = 211;
    media.emit("durationchange");
    vi.runOnlyPendingTimers();

    expect(messages).toContainEqual(expect.objectContaining({ durationMs: 211_000 }));
  });

  it("does not keep a document-wide observer active after finding a duration", () => {
    const media = new FakeMediaElement();
    media.duration = 184;

    const { mutationObserver } = loadContentScript({ media: [media] });

    expect(mutationObserver).toBeUndefined();
  });
});

describe("Songsterr synth playback mode", () => {
  function radio(value: string, checked: boolean) {
    return new FakeElement("", {
      role: "radio",
      value,
      "aria-checked": checked ? "true" : "false"
    });
  }

  it("switches the source control to Synth when Original is active", () => {
    const original = radio("original", true);
    const synth = radio("synth", false);
    const { context } = loadContentScript({
      sourceControl: new FakeSourceControl([original, synth])
    });

    // The script enforces Synth once on load; reset so we assert the standalone call.
    expect(synth.clicks).toBe(1);
    synth.clicks = 0;

    expect(context.ensureSynthPlaybackMode()).toBe("Forced Songsterr playback source to Synth");
    expect(synth.clicks).toBe(1);
    expect(original.clicks).toBe(0);
  });

  it("leaves the source control untouched when Synth is already active", () => {
    const original = radio("original", false);
    const synth = radio("synth", true);
    const { context } = loadContentScript({
      sourceControl: new FakeSourceControl([original, synth])
    });

    expect(context.ensureSynthPlaybackMode()).toBe("");
    expect(synth.clicks).toBe(0);
  });

  it("does nothing when the source control is absent", () => {
    const { context } = loadContentScript();

    expect(context.ensureSynthPlaybackMode()).toBe("");
  });
});

describe("Songsterr transport control resolution", () => {
  // Songsterr's real markup: one player button whose CSS-module class keeps the
  // local name "play" in both states, with a fully localized label.
  function germanPlayButton() {
    return new FakeElement("", {
      "aria-label": "Abspielen ((Leertaste))",
      class: "_8e144G_button _8e144G_play _8e144G_playQuickSourceToggle"
    });
  }

  it("finds the transport toggle by class when the player UI is not in English", () => {
    const play = germanPlayButton();
    const { context } = loadContentScript({ elements: [play] });

    const found = context.findTransportButton("play", "unknown");

    expect(found?.element).toBe(play);
    expect(found?.label).toContain("Abspielen");
  });

  it("prefers an English label match over the class heuristic", () => {
    const labelled = new FakeElement("Play", { "aria-label": "Play" });
    const toggle = germanPlayButton();
    const { context } = loadContentScript({ elements: [toggle, labelled] });

    expect(context.findTransportButton("play", "unknown")?.element).toBe(labelled);
  });

  it("does not mistake a lookalike class for the transport toggle", () => {
    const decoys = [
      new FakeElement("", { "aria-label": "Anzeigemodus", class: "_5Wq5Ea_displayMode" }),
      new FakeElement("", { "aria-label": "Schnellwechsel", class: "_8e144G_playQuickSourceToggle" })
    ];
    const { context } = loadContentScript({ elements: decoys });

    expect(context.findTransportButton("play", "unknown")).toBeUndefined();
  });

  it("never toggles blind when a Stop cannot confirm playback is running", () => {
    const { context } = loadContentScript({ elements: [germanPlayButton()] });

    expect(context.resolveTransportControl("stop", [], "unknown")).toEqual({ kind: "unconfirmed" });
  });

  it("uses the toggle for Stop once playback is confirmed running", () => {
    const play = germanPlayButton();
    const { context } = loadContentScript({ elements: [play] });

    const control = context.resolveTransportControl("stop", [], "playing");

    expect(control.kind).toBe("button");
    expect(control.element).toBe(play);
  });

  it("treats Stop on already-stopped playback as a no-op", () => {
    const { context } = loadContentScript({ elements: [germanPlayButton()] });

    expect(context.resolveTransportControl("stop", [], "stopped")).toEqual({ kind: "no-op" });
  });

  it("resolves the control during prep so the downbeat scans nothing", async () => {
    const play = germanPlayButton();
    const { context, scans } = loadContentScript({ elements: [play] });

    const plan = context.prepareTransport("play", true);
    expect(plan.control.kind).toBe("button");

    const scansAfterPrep = scans.controlQueries;
    const result = await context.controlSongsterr("play", true, plan);

    // The downbeat did the click and nothing else -- no document-wide scan.
    expect(scans.controlQueries).toBe(scansAfterPrep);
    expect(play.clicks).toBe(1);
    expect(result).toMatchObject({ ok: true, controlPath: "player-button" });
  });

  it("re-resolves when Songsterr re-rendered the control away during the count-in", async () => {
    const stale = germanPlayButton();
    const fresh = germanPlayButton();
    const { context } = loadContentScript({ elements: [fresh] });

    // Prep resolved a node that Songsterr's player has since replaced.
    const plan = context.prepareTransport("play", false);
    plan.control = { kind: "button", element: stale, label: "stale" };
    (stale as unknown as { isConnected: boolean }).isConnected = false;

    const result = await context.controlSongsterr("play", false, plan);

    expect(stale.clicks).toBe(0);
    expect(fresh.clicks).toBe(1);
    expect(result).toMatchObject({ ok: true, controlPath: "player-button" });
  });

  it("falls back to the Space shortcut when no play control can be identified", async () => {
    const { context } = loadContentScript({ elements: [] });

    const plan = context.prepareTransport("play", false);
    expect(plan.control.kind).toBe("space");

    const result = await context.controlSongsterr("play", false, plan);
    expect(result).toMatchObject({ ok: true, controlPath: "space-shortcut" });
  });
});

// WebKit re-imposes its "audio needs a live user gesture" rule on every new
// document, so switching songs -- which reloads the tab -- silently disarms an
// iPad: the synthetic click still flips Songsterr's button to Pause while its
// AudioContext stays suspended.
// Songsterr is an SPA, so the next song can be routed to inside the same
// document. That keeps iPadOS's unlocked audio session alive, which a full tab
// reload would throw away -- see the arming suite below.
describe("Songsterr in-page song switching", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SONG_B = "https://www.songsterr.com/a/wsa/song-b-tab-s200";

  it("routes to the next song and confirms the player actually followed", async () => {
    const { context } = loadContentScript({ router: "spa" });

    const result = await context.navigateInPage(SONG_B);

    expect(result.ok).toBe(true);
    expect(context.location.pathname).toBe("/a/wsa/song-b-tab-s200");
  });

  it("keeps the iPad's armed audio across a song switch", async () => {
    const { context, evaluate, fireGesture } = loadContentScript({
      ipad: true,
      router: "spa"
    });
    fireGesture("pointerdown");
    expect(evaluate("audioArmed")).toBe(true);

    await context.navigateInPage(SONG_B);

    // The whole point: no new document, so the unlocked session survives and the
    // member does not have to tap again before the downbeat.
    expect(evaluate("audioArmed")).toBe(true);
    expect(FakeAudioContext.created).toBe(1);
  });

  it("puts the address back when the router ignores the route change", async () => {
    vi.useFakeTimers();
    const { context } = loadContentScript({ router: "none" });
    const before = context.location.href;

    const pending = context.navigateInPage(SONG_B);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;

    // Leaving a rewritten address behind would make the background think the tab
    // is already on the song and skip the real navigation.
    expect(result.ok).toBe(false);
    expect(context.location.href).toBe(before);
  });

  it("does nothing when the tab is already on that path", async () => {
    const { context, keyEvents } = loadContentScript({ router: "spa" });

    const result = await context.navigateInPage(context.location.href);

    expect(result.ok).toBe(true);
    expect(keyEvents).not.toContain("popstate");
  });

  // The reported bug: a re-route fired at the downbeat on a page that was
  // already showing the right song. Songsterr canonicalizes its address after
  // loading -- it rewrites the whole slug from the song id and appends a track
  // suffix -- so the setlist's URL and the player's own URL almost never match
  // literally, and comparing them re-rendered the score just as playback should
  // have started.
  it("recognises the song it is already on after Songsterr rewrote the address", async () => {
    const { context, keyEvents } = loadContentScript({ router: "spa" });
    // What Songsterr left in the address bar: canonical slug, track suffix.
    context.location = {
      href: "https://www.songsterr.com/a/wsa/limp-bizkit-rollin-tab-s100t2",
      origin: "https://www.songsterr.com",
      pathname: "/a/wsa/limp-bizkit-rollin-tab-s100t2",
      search: ""
    };

    // What the setlist still holds for the same song: the original slug.
    const result = await context.navigateInPage(
      "https://www.songsterr.com/a/wsa/song-a-tab-s100"
    );

    expect(result.ok).toBe(true);
    expect(keyEvents).not.toContain("popstate");
  });

  // Guards the seam the background test cannot see: it fakes the content script,
  // so it cannot catch the real one failing to echo the request id -- which
  // silently killed the fallback answer channel and reloaded the tab instead.
  it("echoes the request id on the answer the background matches on", async () => {
    const { context, messages } = loadContentScript({ router: "spa" });
    const listener = context.chrome.runtime.onMessage.listener;

    await new Promise((resolve) => {
      listener(
        {
          type: "bandcueNavigateInPage",
          url: "https://www.songsterr.com/a/wsa/song-b-tab-s200",
          requestId: 42
        },
        {},
        resolve
      );
    });

    expect(messages).toContainEqual(
      expect.objectContaining({ type: "bandcueNavigateResult", requestId: 42, ok: true })
    );
  });

  it("still routes when the song id genuinely differs", async () => {
    const { context, keyEvents } = loadContentScript({ router: "spa" });

    const result = await context.navigateInPage(
      "https://www.songsterr.com/a/wsa/song-a-tab-s999"
    );

    expect(result.ok).toBe(true);
    expect(keyEvents).toContain("popstate");
  });

  it("refuses to route off Songsterr's own origin", async () => {
    const { context, keyEvents } = loadContentScript({ router: "spa" });

    const result = await context.navigateInPage("https://example.com/a/wsa/x-tab-s1");

    expect(result.ok).toBe(false);
    expect(keyEvents).not.toContain("popstate");
  });
});

describe("Songsterr audio arming on iPadOS", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a tap and tells the host while audio is unarmed", () => {
    vi.useFakeTimers();
    const { messages, overlay } = loadContentScript({ ipad: true });
    vi.runOnlyPendingTimers();

    expect(overlay()?.textContent).toMatch(/tap to enable/i);
    expect(messages).toContainEqual(
      expect.objectContaining({ detail: expect.stringMatching(/not armed/i) })
    );
  });

  it("arms on a real tap and drops the banner", () => {
    vi.useFakeTimers();
    const { messages, evaluate, fireGesture, overlay } = loadContentScript({ ipad: true });

    fireGesture("pointerdown");
    fireGesture("pointerup");
    vi.advanceTimersByTime(500);

    expect(evaluate("audioArmed")).toBe(true);
    // Sounding a silent frame is what clears the restriction; resume() alone can
    // leave it in place.
    expect(evaluate("audioArmContext").sounded).toBeGreaterThanOrEqual(1);
    expect(overlay()?.isConnected).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({ detail: expect.stringMatching(/audio is armed/i) })
    );
  });

  it("holds a silent looping source so an idle session is not reclaimed", () => {
    vi.useFakeTimers();
    const { evaluate, fireGesture } = loadContentScript({ ipad: true });

    fireGesture("pointerdown");
    fireGesture("pointerdown");
    vi.advanceTimersByTime(500);

    // One keep-alive, however many gestures arrive.
    expect(evaluate("audioArmContext").looping).toBe(1);
  });

  it("keeps the banner up until Songsterr's own engine has been started too", () => {
    vi.useFakeTimers();
    const { messages, evaluate, fireGesture, overlay } = loadContentScript({ ipad: true });

    // pointerdown arms our context, but nothing has reached Songsterr's yet --
    // the state members used to be stuck in, armed and still silent.
    fireGesture("pointerdown");
    vi.runOnlyPendingTimers();

    expect(evaluate("audioArmed")).toBe(true);
    expect(evaluate("songsterrPrimed")).toBe(false);
    expect(overlay()?.isConnected).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({ detail: expect.stringMatching(/engine is not started/i) })
    );
  });

  it("ignores untrusted events, so our own Space shortcut cannot fake a gesture", () => {
    const { evaluate, fireGesture } = loadContentScript({ ipad: true });

    fireGesture("keydown", { isTrusted: false });

    expect(evaluate("audioArmed")).toBe(false);
    expect(FakeAudioContext.created).toBe(0);
  });

  it("re-raises the banner when iOS suspends the context behind our back", () => {
    vi.useFakeTimers();
    const { evaluate, fireGesture, overlay } = loadContentScript({ ipad: true });
    fireGesture("pointerdown");
    vi.runOnlyPendingTimers();

    evaluate("audioArmContext").suspendFromSystem();
    vi.runOnlyPendingTimers();

    expect(evaluate("audioArmed")).toBe(false);
    expect(overlay()?.textContent).toMatch(/tap to enable/i);
  });

  it("warns the host when a play fires while audio is still unarmed", async () => {
    const play = new FakeElement("", {
      "aria-label": "Play",
      class: "_8e144G_button _8e144G_play"
    });
    const { context } = loadContentScript({ elements: [play], ipad: true });

    const result = await context.controlSongsterr("play", false);

    // The click lands and Songsterr's button flips, so this is a "success" that
    // would otherwise be silent -- say so rather than reporting a clean start.
    expect(result).toMatchObject({ ok: true, controlPath: "player-button" });
    expect(result.detail).toMatch(/not armed/i);
  });

  it("keeps the downbeat free of arming work once armed", async () => {
    const play = new FakeElement("", {
      "aria-label": "Play",
      class: "_8e144G_button _8e144G_play"
    });
    const { context, scans, fireGesture } = loadContentScript({ elements: [play], ipad: true });
    fireGesture("pointerdown");

    const plan = context.prepareTransport("play", true);
    const scansAfterPrep = scans.controlQueries;
    const result = await context.controlSongsterr("play", true, plan);

    expect(scans.controlQueries).toBe(scansAfterPrep);
    expect(play.clicks).toBe(1);
    expect(result.detail).not.toMatch(/not armed/i);
  });

  it("stays completely out of the way on desktop Chrome", () => {
    const { documentListeners, overlay } = loadContentScript();

    expect(documentListeners.pointerdown).toBeUndefined();
    expect(overlay()).toBeUndefined();
  });
});

// Songsterr's player transport as it really is on a localized UI: a single
// toggle identified by its CSS-module class, with no English label to read.
function transportToggle() {
  return new FakeElement("", { class: "_8e144G_button _8e144G_play" });
}

describe("Songsterr audio priming on iPadOS", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("presses Play and Stop for the member, inside their own tap", () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const { evaluate, fireGesture, keysPressed, overlay } = loadContentScript({
      elements: [toggle],
      ipad: true
    });

    fireGesture("touchend");

    // Synchronously, still inside the gesture: the document's live user
    // activation is what lets Songsterr's own context start, and it is gone by
    // the next task.
    expect(toggle.clicks).toBe(1);

    vi.advanceTimersByTime(200);
    expect(toggle.clicks).toBe(2);
    expect(keysPressed).toContain("Backspace");
    expect(evaluate("songsterrPrimed")).toBe(true);
    expect(overlay()?.isConnected).toBe(false);
  });

  it("primes only once, however many events one tap produces", () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const { fireGesture } = loadContentScript({ elements: [toggle], ipad: true });

    fireGesture("pointerdown");
    fireGesture("touchend");
    fireGesture("pointerup");
    fireGesture("click");
    vi.advanceTimersByTime(500);

    // One play, one stop -- not a cycle per event.
    expect(toggle.clicks).toBe(2);
  });

  it("leaves the member's own press of the player control alone", () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const target = new FakeElement();
    target.closestTarget = toggle;
    const { evaluate, fireGesture } = loadContentScript({ elements: [toggle], ipad: true });

    fireGesture("touchend", { target });
    vi.advanceTimersByTime(500);

    // Their gesture already reaches Songsterr; a click of ours would only undo it.
    expect(toggle.clicks).toBe(0);
    expect(evaluate("songsterrPrimed")).toBe(true);
  });

  it("never touches the transport while a scheduled command is pending", () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const { evaluate, fireGesture } = loadContentScript({ elements: [toggle], ipad: true });
    evaluate("transportCommandPending = true");

    fireGesture("touchend");
    vi.advanceTimersByTime(500);

    expect(toggle.clicks).toBe(0);
    expect(evaluate("songsterrPrimed")).toBe(false);
  });

  it("never touches the transport while BandCue playback is running", () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const { evaluate, fireGesture } = loadContentScript({ elements: [toggle], ipad: true });
    evaluate("bandcuePlaybackActive = true");

    fireGesture("touchend");
    vi.advanceTimersByTime(500);

    expect(toggle.clicks).toBe(0);
  });

  it("ends a priming cycle at once when a real command arrives", async () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const { context, fireGesture } = loadContentScript({ elements: [toggle], ipad: true });
    fireGesture("touchend");
    expect(toggle.clicks).toBe(1);

    const transport = context.chrome.runtime.onMessage.listener(
      { type: "bandcueTransport", action: "play", dueLocalAt: 0 },
      {},
      () => {}
    );

    // The priming stop has already run by the time the command is being
    // prepared, so it can never land inside the real play.
    expect(toggle.clicks).toBe(2);
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(transport).toBe(true);
  });

  it("re-primes after an in-page song switch", async () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const { context, evaluate, fireGesture } = loadContentScript({
      elements: [toggle],
      ipad: true,
      router: "spa"
    });
    fireGesture("touchend");
    vi.advanceTimersByTime(200);
    expect(toggle.clicks).toBe(2);

    const switched = context.navigateInPage("https://www.songsterr.com/a/wsa/song-b-tab-s200", {
      allowAudioPrime: true
    });
    await vi.advanceTimersByTimeAsync(100);
    await switched;
    // The document -- and our arm -- survived, but Songsterr rebuilt its player.
    expect(evaluate("songsterrPrimed")).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(toggle.clicks).toBe(4);
    expect(evaluate("songsterrPrimed")).toBe(true);
  });

  it("does not re-prime a switch that a downbeat is already following", async () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const { context, evaluate, fireGesture } = loadContentScript({
      elements: [toggle],
      ipad: true,
      router: "spa"
    });
    fireGesture("touchend");
    vi.advanceTimersByTime(200);

    const switched = context.navigateInPage("https://www.songsterr.com/a/wsa/song-b-tab-s200", {
      allowAudioPrime: false
    });
    await vi.advanceTimersByTimeAsync(100);
    await switched;
    await vi.advanceTimersByTimeAsync(1000);

    // Still the one play/stop from the tap: nothing of ours goes near the
    // transport once the count-in has started.
    expect(toggle.clicks).toBe(2);
    expect(evaluate("songsterrPrimed")).toBe(true);
  });

  it("tells the host when a start left the player standing still", async () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const clock = new FakeElement("0:00 / 3:45", { class: "player-time" });
    const { context, evaluate, fireGesture, messages } = loadContentScript({
      elements: [toggle, clock],
      ipad: true
    });
    fireGesture("touchend");
    vi.advanceTimersByTime(200);
    expect(evaluate("songsterrPrimed")).toBe(true);

    const played = context.runScheduledTransport({ action: "play", dueLocalAt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await played;
    await vi.advanceTimersByTimeAsync(1000);

    // The click landed and Songsterr flipped its button, but the position never
    // moved: the silent WebKit start that used to be reported as a clean start.
    expect(evaluate("songsterrPrimed")).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({ detail: expect.stringMatching(/never moved/i) })
    );
  });

  it("says nothing when the player is moving", async () => {
    vi.useFakeTimers();
    const toggle = transportToggle();
    const clock = new FakeElement("0:00 / 3:45", { class: "player-time" });
    const { context, messages } = loadContentScript({ elements: [toggle, clock], ipad: true });

    const played = context.runScheduledTransport({ action: "play", dueLocalAt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await played;
    clock.textContent = "0:01 / 3:45";
    await vi.advanceTimersByTimeAsync(1000);

    expect(messages).not.toContainEqual(
      expect.objectContaining({ detail: expect.stringMatching(/never moved/i) })
    );
  });
});

describe("Songsterr downbeat timing", () => {
  it("reports how late the wait actually woke up", async () => {
    const { context } = loadContentScript();

    const latenessMs = await context.waitUntilLocalTime(Date.now() - 200);

    expect(latenessMs).toBeGreaterThanOrEqual(200);
  });

  it("returns immediately when no downbeat was scheduled", async () => {
    const { context } = loadContentScript();

    expect(await context.waitUntilLocalTime(0)).toBe(0);
  });

  it("adapts the action-cost estimate toward measured samples", () => {
    const { context, evaluate } = loadContentScript();

    const seeded = evaluate("actionCostEstimateMs");
    context.recordActionCost(seeded + 20);

    expect(evaluate("actionCostEstimateMs")).toBeGreaterThan(seeded);
    expect(evaluate("actionCostEstimateMs")).toBeLessThan(seeded + 20);
  });

  it("ignores nonsense samples and caps a pathological one", () => {
    const { context, evaluate } = loadContentScript();

    const seeded = evaluate("actionCostEstimateMs");
    context.recordActionCost(-5);
    context.recordActionCost(Number.NaN);
    expect(evaluate("actionCostEstimateMs")).toBe(seeded);

    for (let i = 0; i < 50; i += 1) {
      context.recordActionCost(10_000);
    }
    // Aiming early is bounded, so one bad sample can never pull starts far ahead.
    expect(evaluate("actionCostEstimateMs")).toBeLessThanOrEqual(evaluate("MAX_ACTION_COST_MS"));
  });
});
