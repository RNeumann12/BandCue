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

  getBoundingClientRect() {
    return { width: 100, height: 20, top: 10 };
  }

  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
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

class FakeKeyboardEvent {}

function loadContentScript({
  elements = [],
  media = [],
  sourceControl = null
}: {
  elements?: FakeElement[];
  media?: FakeMediaElement[];
  sourceControl?: FakeSourceControl | null;
} = {}) {
  const messages: unknown[] = [];
  const document = {
    title: "Song A Tab by Artist",
    documentElement: new FakeElement(),
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
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const context: any = {
    chrome,
    document,
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
    Math,
    RegExp,
    WeakSet
  };
  vm.createContext(context);
  vm.runInContext(contentScriptSource, context);
  return { context, messages };
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
