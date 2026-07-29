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

  closest() {
    return null;
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

  createBuffer() {
    return {};
  }

  createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {
        this.sounded += 1;
      }
    };
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
  ipad = false
}: {
  elements?: FakeElement[];
  media?: FakeMediaElement[];
  sourceControl?: FakeSourceControl | null;
  ipad?: boolean;
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
      onMessage: { addListener() {} },
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
  const window = {
    innerHeight: 900,
    dispatchEvent(event: { type?: string }) {
      keyEvents.push(event?.type ?? "");
      return true;
    }
  };
  (document as unknown as { dispatchEvent: (e: { type?: string }) => boolean }).dispatchEvent = (event) => {
    keyEvents.push(event?.type ?? "");
    return true;
  };

  const context: any = {
    chrome,
    document,
    window,
    location: { href: "https://www.songsterr.com/a/wsa/song-a-tab-s100" },
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
    vi.runOnlyPendingTimers();

    expect(evaluate("audioArmed")).toBe(true);
    // Sounding a silent frame is what clears the restriction; resume() alone can
    // leave it in place.
    expect(evaluate("audioArmContext").sounded).toBe(1);
    expect(overlay()?.isConnected).toBe(false);
    expect(messages).toContainEqual(
      expect.objectContaining({ detail: expect.stringMatching(/audio is armed/i) })
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
