import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LAN_SCAN_SUBNETS,
  describeLanScanSubnets
} from "../../src/shared/room-locator.js";

const backgroundSource = readFileSync(
  fileURLToPath(new URL("./background.js", import.meta.url)),
  "utf8"
);
const permissionsSource = readFileSync(
  fileURLToPath(new URL("./room-permissions.js", import.meta.url)),
  "utf8"
);

const SONG_A = "https://www.songsterr.com/a/wsa/song-a-s100";
const SONG_B = "https://www.songsterr.com/a/wsa/song-b-s200";
// Same song A on each instrument tab. Songsterr puts the instrument category in
// the slug ("-bass-tab"/"-drum-tab", else the lead guitar tab).
const SONG_A_TAB = "https://www.songsterr.com/a/wsa/song-a-tab-s100";
const SONG_A_BASS = "https://www.songsterr.com/a/wsa/song-a-bass-tab-s100";
const SONG_A_DRUM = "https://www.songsterr.com/a/wsa/song-a-drum-tab-s100";
const SONG_A_EASY_DRUM = "https://www.songsterr.com/a/wsa/song-a-easy-drum-tab-s5446545";
const SONG_B_TAB = "https://www.songsterr.com/a/wsa/song-b-tab-s200";
const SONG_B_BASS = "https://www.songsterr.com/a/wsa/song-b-bass-tab-s200";

type FakeTab = { id: number; url: string; windowId: number; active?: boolean };

function loadBackground(
  initialTabs: FakeTab[],
  // Whether the content script can swap songs through Songsterr's router. The
  // default is "no", so every case that does not opt in exercises the full-tab
  // navigation fallback.
  // true/false: the content script replies. "hang": the reply channel is
  // dropped, as Safari-derived browsers do for a slow async sendResponse.
  { inPageNav = false, missingContentOnce = false }: {
    inPageNav?: boolean | "hang";
    missingContentOnce?: boolean;
  } = {}
) {
  const created: Array<{ url: string; active?: boolean }> = [];
  const updated: Array<{ id: number; url?: string; active?: boolean }> = [];
  const inPageNavs: string[] = [];
  // Transport messages the background handed to the content script.
  const transportMessages: Array<Record<string, unknown>> = [];
  // Request ids the background stamped on each in-page switch, so a test can
  // answer a specific one the way the content script does.
  const inPageNavRequestIds: number[] = [];
  // Whether each switch let the content script re-prime the iPad's audio, which
  // is only safe when no downbeat is already on its way.
  const inPageNavAudioPrimes: Array<boolean | undefined> = [];
  const reloadedTabs: number[] = [];
  let shouldRejectMissingContent = missingContentOnce;
  let nextId = 1000;
  const onUpdatedListeners = new Set<(id: number, info: any, tab: FakeTab) => void>();

  // Tabs created/updated report "complete" on the next tick so waitForTabReady resolves.
  const fireComplete = (tab: FakeTab) =>
    setTimeout(() => {
      for (const listener of [...onUpdatedListeners]) {
        listener(tab.id, { status: "complete" }, tab);
      }
    }, 0);

  let messageListener: ((message: any, sender: any, sendResponse: any) => unknown) | undefined;
  const chrome = {
    runtime: { onMessage: { addListener: (fn: any) => { messageListener = fn; } } },
    permissions: { contains: async () => true },
    storage: { local: { get: (_keys: unknown, cb: (v: object) => void) => cb({}), set() {} } },
    windows: { update: async () => undefined },
    tabs: {
      onUpdated: {
        addListener: (l: any) => onUpdatedListeners.add(l),
        removeListener: (l: any) => onUpdatedListeners.delete(l)
      },
      onRemoved: { addListener() {} },
      query: async () => initialTabs.map((tab) => ({ ...tab })),
      get: async (id: number) => initialTabs.find((tab) => tab.id === id),
      reload: async (id: number) => {
        const tab = initialTabs.find((candidate) => candidate.id === id);
        if (tab) {
          reloadedTabs.push(id);
          fireComplete(tab);
        }
      },
      sendMessage: async (
        id: number,
        message: { type?: string; url?: string; requestId?: number; allowAudioPrime?: boolean }
      ) => {
        if (shouldRejectMissingContent) {
          shouldRejectMissingContent = false;
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        if (message?.type === "bandcueNavigateInPage") {
          inPageNavs.push(message.url ?? "");
          inPageNavRequestIds.push(message.requestId ?? -1);
          inPageNavAudioPrimes.push(message.allowAudioPrime);
          if (inPageNav === "hang") {
            return new Promise(() => {});
          }
          if (!inPageNav) {
            return { ok: false, detail: "Songsterr did not pick up the route change" };
          }
          // A real in-page switch leaves the tab on the new URL without a load.
          const tab = initialTabs.find((t) => t.id === id);
          if (tab && message.url) tab.url = message.url;
          return { ok: true };
        }
        if (message?.type === "bandcueTransport") {
          transportMessages.push({ ...message });
          return { ok: true, startMeasure: (message as { startMeasure?: number }).startMeasure };
        }
        return { ok: true };
      },
      create: async ({ url, active }: { url: string; active?: boolean }) => {
        const tab: FakeTab = { id: nextId++, url, windowId: 1, active };
        created.push({ url, active });
        fireComplete(tab);
        return tab;
      },
      update: async (id: number, props: { url?: string; active?: boolean }) => {
        const tab = initialTabs.find((t) => t.id === id) ?? { id, url: "", windowId: 1 };
        if (props.url) tab.url = props.url;
        if (props.active !== undefined) tab.active = props.active;
        updated.push({ id, ...props });
        fireComplete(tab);
        return tab;
      }
    }
  };

  // Fake WebSocket that records listeners so a test can feed the script a server
  // message. readyState stays CONNECTING so send() (status reporting) no-ops.
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    listeners: Record<string, Array<(evt: any) => void>> = {};
    constructor(public url: string) {
      sockets.push(this);
    }
    addEventListener(type: string, fn: (evt: any) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    emit(type: string, evt: any) {
      for (const fn of this.listeners[type] ?? []) fn(evt);
    }
  }

  const context: any = {
    chrome,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        type: "roomState",
        roomCode: "ABC123",
        companionUrl: "http://127.0.0.1:4173/?token=TEST"
      })
    }),
    AbortController,
    setTimeout,
    clearTimeout,
    clearInterval,
    setInterval,
    URL,
    Date,
    JSON,
    Math,
    console,
    importScripts() {},
    // Fixed so the derived device name is deterministic; userAgentData is left
    // undefined to exercise the classic user-agent fallback too.
    navigator: {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    },
    WebSocket: FakeSocket
  };
  vm.createContext(context);
  vm.runInContext(permissionsSource, context);
  vm.runInContext(backgroundSource, context);

  const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

  // Connect via an absolute room URL (no network probe) and deliver one server
  // message through the socket the script opens, mirroring a real coordinator.
  async function deliverServerMessage(message: unknown) {
    await context.configureConnection("http://127.0.0.1:4173/");
    await flush();
    const socket = sockets[sockets.length - 1];
    socket.emit("message", { data: JSON.stringify(message) });
    await flush();
  }

  // Drive the real onMessage handler the popup uses (e.g. to set the instrument).
  function sendRuntimeMessage(message: unknown, sender: unknown = {}) {
    return new Promise((resolve) => {
      messageListener?.(message, sender, resolve);
    });
  }

  // Brings the socket fully up (the "open" handler is what sends clientHello),
  // then hands back everything the script pushed to the coordinator. Callers
  // should disconnect afterwards so the clock/heartbeat intervals don't outlive
  // the test.
  async function openConnection() {
    await context.configureConnection("http://127.0.0.1:4173/");
    await flush();
    const socket = sockets[sockets.length - 1];
    socket.readyState = 1;
    socket.emit("open", {});
    await flush();
    return socket;
  }

  // `let` bindings live in the script's lexical scope, not on the context
  // object, so module-level state has to be read by evaluating in the context.
  const evaluate = (expression: string) => vm.runInContext(expression, context);

  return {
    context,
    created,
    updated,
    inPageNavs,
    inPageNavRequestIds,
    inPageNavAudioPrimes,
    reloadedTabs,
    transportMessages,
    deliverServerMessage,
    sendRuntimeMessage,
    openConnection,
    evaluate
  };
}

describe("content script recovery", () => {
  it("reloads and retries when an already-open Songsterr tab has no receiver", async () => {
    const { context, reloadedTabs } = loadBackground(
      [{ id: 7, url: SONG_A_TAB, windowId: 1, active: true }],
      { missingContentOnce: true }
    );

    const result = await context.sendMessageToSongsterrTab(7, {
      type: "bandcueSetTempo",
      tempoPercent: 92
    });

    expect(reloadedTabs).toEqual([7]);
    expect(result).toEqual({ ok: true });
  });
});

describe("ensureSongsterrTabs tab reuse", () => {
  beforeEach(() => {
    // nothing shared between cases
  });

  it("reuses the tab already on the exact song without creating or navigating", async () => {
    const { context, created, updated } = loadBackground([
      { id: 1, url: SONG_A, windowId: 1 }
    ]);

    const tabs = await context.ensureSongsterrTabs({ songsterrUrl: SONG_A }, { active: true });

    expect(tabs.map((t: FakeTab) => t.id)).toEqual([1]);
    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });

  it("navigates an existing Songsterr tab to the new song instead of opening a new tab", async () => {
    const { context, created, updated } = loadBackground([
      { id: 1, url: SONG_A, windowId: 1 }
    ]);

    const tabs = await context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true });

    expect(created).toHaveLength(0);
    expect(updated.some((u) => u.id === 1 && u.url === SONG_B)).toBe(true);
    expect(tabs.map((t: FakeTab) => t.id)).toEqual([1]);
  });

  // A full navigation tears the document down, which on iPadOS discards the
  // unlocked audio session with it and leaves playback silent until the member
  // taps the screen again. Songsterr is an SPA, so the song can be swapped in
  // place instead -- verified against the live player.
  it("switches songs through Songsterr's own router instead of reloading the tab", async () => {
    const { context, created, updated, inPageNavs } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1 }],
      { inPageNav: true }
    );

    const tabs = await context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true });

    expect(inPageNavs).toEqual([SONG_B]);
    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
    expect(tabs.map((t: FakeTab) => t.url)).toEqual([SONG_B]);
  });

  // The iPad's audio priming is a real play/stop through Songsterr's transport,
  // so a switch made *inside* a count-in must not invite one.
  it("lets an ordinary song switch re-prime the iPad's audio, but not the count-in's own", async () => {
    const { context, inPageNavAudioPrimes } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1 }],
      { inPageNav: true }
    );

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true });
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A }, { imminentPlay: true });

    expect(inPageNavAudioPrimes).toEqual([true, false]);
  });

  it("falls back to a full navigation when the router ignores the route change", async () => {
    const { context, created, updated, inPageNavs } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1 }],
      { inPageNav: false }
    );

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true });

    expect(inPageNavs).toEqual([SONG_B]);
    expect(created).toHaveLength(0);
    expect(updated.some((u) => u.id === 1 && u.url === SONG_B)).toBe(true);
  });

  // The reason the answer is accepted from two directions: Orion on iPadOS --
  // the only platform this path exists for -- does not reliably hold an async
  // sendResponse channel open, and losing the answer means falling back to the
  // very reload we are trying to avoid.
  it("takes the router's answer over the status channel when the reply is dropped", async () => {
    const { context, created, updated, sendRuntimeMessage, inPageNavRequestIds } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1 }],
      { inPageNav: "hang" }
    );

    const pending = context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true });
    // Let ensureSongsterrTabs reach the in-page request before answering it.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // A notification, so the handler answers nothing -- do not wait for a reply.
    void sendRuntimeMessage(
      { type: "bandcueNavigateResult", requestId: inPageNavRequestIds[0], ok: true },
      { tab: { id: 1 } }
    );
    await pending;

    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });

  it("ignores a route result that answers some other request", async () => {
    const { context, sendRuntimeMessage, updated } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1 }],
      { inPageNav: false }
    );

    void sendRuntimeMessage(
      { type: "bandcueNavigateResult", requestId: 9999, ok: true },
      { tab: { id: 1 } }
    );
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true });

    // A stale result must not be mistaken for this switch's answer.
    expect(updated.some((u) => u.id === 1 && u.url === SONG_B)).toBe(true);
  });

  // The exact shape of the bug this replaced: the host's openSongCommand and the
  // count-in's eager pre-open both open the same song, and while they were keyed
  // by tab the second overwrote the first's resolver -- so one call's timeout
  // answered the other with a spurious refusal and reloaded a tab that was
  // already on the right song.
  it("does not reload when two callers open the same song at once", async () => {
    const { context, created, updated, inPageNavs } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1 }],
      { inPageNav: true }
    );

    const [first, second] = await Promise.all([
      context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true }),
      context.ensureSongsterrTabs({ songsterrUrl: SONG_B })
    ]);

    // One switch, shared by both callers -- and no reload for either.
    expect(inPageNavs).toEqual([SONG_B]);
    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
    expect(first.map((t: FakeTab) => t.id)).toEqual([1]);
    expect(second.map((t: FakeTab) => t.id)).toEqual([1]);
  });

  it("never asks the router when the tab is already on the song", async () => {
    const { context, inPageNavs } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1 }],
      { inPageNav: true }
    );

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A }, { active: true });

    expect(inPageNavs).toEqual([]);
  });

  // iPadOS purges background tabs and reloads them on activation, which would
  // undo the in-page switch we just made.
  it("does not re-activate a tab that is already in front", async () => {
    const { context, updated } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1, active: true }],
      { inPageNav: true }
    );

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true });

    expect(updated).toHaveLength(0);
  });

  it("still brings a background tab to the front after an in-page switch", async () => {
    const { context, updated } = loadBackground(
      [{ id: 1, url: SONG_A, windowId: 1, active: false }],
      { inPageNav: true }
    );

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_B }, { active: true });

    expect(updated).toEqual([{ id: 1, active: true }]);
  });

  it("opens a new tab only when no Songsterr tab exists", async () => {
    const { context, created, updated } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A }, { active: true });

    expect(created).toHaveLength(1);
    expect(created[0].url).toBe(SONG_A);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });
});

describe("device naming", () => {
  it("derives a name from the instrument and platform when the member set none", async () => {
    const { context, sendRuntimeMessage } = loadBackground([]);

    expect(context.resolveDeviceName()).toBe("Songsterr (Windows)");

    const state: any = await sendRuntimeMessage({ type: "popupSetInstrument", instrument: "bass" });
    expect(state.effectiveDeviceName).toBe("Bass Songsterr (Windows)");
  });

  it("distinguishes the instruments so band mates do not collide by default", async () => {
    const { sendRuntimeMessage } = loadBackground([]);
    const names: string[] = [];

    for (const instrument of ["guitar", "bass", "drum"]) {
      const state: any = await sendRuntimeMessage({ type: "popupSetInstrument", instrument });
      names.push(state.effectiveDeviceName);
    }

    expect(names).toEqual([
      "Guitar Songsterr (Windows)",
      "Bass Songsterr (Windows)",
      "Drums Songsterr (Windows)"
    ]);
  });

  it("lets the member's own name win over the derived default", async () => {
    const { context, sendRuntimeMessage } = loadBackground([]);

    const state: any = await sendRuntimeMessage({
      type: "popupSetDeviceName",
      deviceName: "  Toms   Laptop  "
    });

    // Collapsed whitespace, matching the coordinator's own trimText normalization.
    expect(state.deviceName).toBe("Toms Laptop");
    expect(state.effectiveDeviceName).toBe("Toms Laptop");
    expect(context.resolveDeviceName()).toBe("Toms Laptop");
  });

  it("falls back to the derived default when the name is cleared", async () => {
    const { context, sendRuntimeMessage } = loadBackground([]);

    await sendRuntimeMessage({ type: "popupSetDeviceName", deviceName: "Toms Laptop" });
    const state: any = await sendRuntimeMessage({ type: "popupSetDeviceName", deviceName: "   " });

    expect(state.deviceName).toBe("");
    expect(context.resolveDeviceName()).toBe("Songsterr (Windows)");
  });

  it("caps a pasted name at the length the coordinator accepts", async () => {
    const { sendRuntimeMessage } = loadBackground([]);

    const state: any = await sendRuntimeMessage({
      type: "popupSetDeviceName",
      deviceName: "x".repeat(200)
    });

    expect(state.deviceName).toHaveLength(80);
  });

  it("announces itself under the resolved name, not a hardcoded one", async () => {
    const { context, openConnection, sendRuntimeMessage } = loadBackground([]);
    await sendRuntimeMessage({ type: "popupSetInstrument", instrument: "drum" });

    const socket = await openConnection();
    const hello = socket.sent.map((raw: string) => JSON.parse(raw)).find((m: any) => m.type === "clientHello");
    context.disconnectByUser();

    expect(hello?.deviceName).toBe("Drums Songsterr (Windows)");
  });

  it("re-announces to the room when the member renames the device", async () => {
    const { context, openConnection, sendRuntimeMessage } = loadBackground([]);

    const first = await openConnection();
    expect(first.readyState).toBe(1);

    await sendRuntimeMessage({ type: "popupSetDeviceName", deviceName: "Toms Laptop" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    // A rename only reaches the room via a fresh clientHello, so the old socket
    // must have been replaced.
    expect(first.readyState).toBe(3);
    context.disconnectByUser();
  });

  it("does not reconnect when the name did not actually change", async () => {
    const { context, openConnection, sendRuntimeMessage } = loadBackground([]);

    const first = await openConnection();
    await sendRuntimeMessage({ type: "popupSetInstrument", instrument: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(first.readyState).toBe(1);
    context.disconnectByUser();
  });
});

describe("dispatch lead self-correction", () => {
  it("leaves the lead alone when prep had time to run before the downbeat", () => {
    const { context, evaluate } = loadBackground([]);
    const before = evaluate("adaptiveDispatchLeadMs");

    expect(context.adjustDispatchLeadForTiming({ preparedAheadMs: 320 }, "play")).toBe("");
    expect(evaluate("adaptiveDispatchLeadMs")).toBe(before);
  });

  it("grows the lead by the overrun plus a cushion when prep ran out of time", () => {
    const { context, evaluate } = loadBackground([]);
    const before = evaluate("adaptiveDispatchLeadMs");

    const detail = context.adjustDispatchLeadForTiming({ preparedAheadMs: -180 }, "play");

    expect(evaluate("adaptiveDispatchLeadMs")).toBe(before + 180 + 150);
    expect(detail).toContain("count-in was extended");
  });

  // Measured on a real iPad: a Stop is scheduled for *now*, so it always reports
  // arriving with no lead left -- the IPC hop alone guarantees it. Feeding those
  // into the estimate ratcheted it to the 2500 ms cap over a rehearsal, and that
  // figure becomes a floor under every Play for the whole band.
  it("never lets a Stop grow the count-in every Play has to sit through", () => {
    const { context, evaluate } = loadBackground([]);
    const before = evaluate("adaptiveDispatchLeadMs");

    for (let i = 0; i < 20; i += 1) {
      expect(context.adjustDispatchLeadForTiming({ preparedAheadMs: -400 }, "stop")).toBe("");
    }

    expect(evaluate("adaptiveDispatchLeadMs")).toBe(before);
  });

  it("never grows the lead past the cap", () => {
    const { context, evaluate } = loadBackground([]);

    for (let i = 0; i < 20; i += 1) {
      context.adjustDispatchLeadForTiming({ preparedAheadMs: -900 }, "play");
    }

    expect(evaluate("adaptiveDispatchLeadMs")).toBe(evaluate("MAX_DISPATCH_LEAD_MS"));
  });

  it("reports the lead it needs so the room's count-in can cover it", () => {
    const { context, evaluate } = loadBackground([]);
    context.adjustDispatchLeadForTiming({ preparedAheadMs: -200 }, "play");

    const status = context.normalizeAdapterStatus({ ready: true });

    expect(status.requiredLeadMs).toBe(evaluate("adaptiveDispatchLeadMs"));
  });

  it("explains a background Songsterr tab instead of leaving the lateness a mystery", () => {
    const { context } = loadBackground([]);

    expect(context.describeTiming({ deviationMs: 240, hidden: true }))
      .toContain("started 240 ms late");
    expect(context.describeTiming({ deviationMs: 240, hidden: true }))
      .toContain("background");
    // A start that landed on the beat needs no commentary.
    expect(context.describeTiming({ deviationMs: 4, hidden: false })).toBe("");
  });
});

describe("discovery constants", () => {
  it("keeps extension LAN scan diagnostics in sync with shared defaults", () => {
    const { context } = loadBackground([]);

    expect(context.formatLanScanSubnets()).toBe(describeLanScanSubnets(DEFAULT_LAN_SCAN_SUBNETS));
  });

  it("retries a direct host join with a longer weak-signal probe", async () => {
    const { context } = loadBackground([]);
    const calls: string[] = [];
    context.fetch = async (url: string) => {
      calls.push(String(url));
      if (calls.length === 1) {
        throw new Error("simulated packet loss");
      }
      return {
        ok: true,
        json: async () => ({
          type: "roomState",
          roomCode: "ABC123",
          companionUrl: "http://192.168.1.44:4173/?token=TEST"
        })
      };
    };

    const endpoint = await context.resolveRoomEndpoint("192.168.1.44:4173");

    expect(calls).toEqual([
      "http://192.168.1.44:4173/api/room",
      "http://192.168.1.44:4173/api/room"
    ]);
    expect(endpoint.roomUrl).toBe("http://192.168.1.44:4173/?token=TEST");
    expect(endpoint.wsUrl).toBe("ws://192.168.1.44:4173/ws?token=TEST");
  });
});

describe("play count-in pre-opens the tab", () => {
  // scheduledServerTime far in the future so sendTransportToSongsterr's own
  // setTimeout never fires during the test -- any tab change we observe must come
  // from the eager open at count-in start, not from play time.
  const playCommand = (song: object) => ({
    type: "transportCommand",
    action: "play",
    sequenceId: 1,
    leaderId: "host",
    scheduledServerTime: Date.now() + 1_000_000,
    resetBeforePlay: true,
    currentSong: { song }
  });

  it("navigates an existing tab to the new song when the count-in starts", async () => {
    const { created, updated, deliverServerMessage } = loadBackground([
      { id: 1, url: SONG_A, windowId: 1 }
    ]);

    await deliverServerMessage(playCommand({ songsterrUrl: SONG_B }));

    // Navigation happened immediately on the command, before the count-in elapsed.
    expect(created).toHaveLength(0);
    expect(updated.some((u) => u.id === 1 && u.url === SONG_B)).toBe(true);
  });

  it("does not reload a tab already on the song", async () => {
    const { created, updated, deliverServerMessage } = loadBackground([
      { id: 1, url: SONG_B, windowId: 1 }
    ]);

    await deliverServerMessage(playCommand({ songsterrUrl: SONG_B }));

    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });

});

describe("downbeat never navigates or reloads", () => {
  // The downbeat dispatcher (sendTransportToSongsterr) only locates an existing
  // tab. It must never navigate or create one -- the pre-open at count-in start
  // owns that. Re-navigating here reloads the page on the downbeat and throws the
  // band out of sync, even when the tab is technically a Songsterr tab.
  it("dispatches play to an existing Songsterr tab without re-navigating it", async () => {
    const { context, created, updated } = loadBackground([
      { id: 1, url: SONG_A, windowId: 1 }
    ]);

    // The pre-open already handled SONG_B; the downbeat runs against whatever tab
    // exists. Even though tab 1's URL does not exactly match SONG_B, it must not
    // be reloaded.
    await context.sendTransportToSongsterr("play", 1, { songsterrUrl: SONG_B });

    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });

  it("dispatches stop to an existing Songsterr tab without re-navigating it", async () => {
    const { context, created, updated } = loadBackground([
      { id: 1, url: SONG_A, windowId: 1 }
    ]);

    await context.sendTransportToSongsterr("stop", 2, { songsterrUrl: SONG_B });

    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });
});

describe("start measure hand-off", () => {
  it("tells the content script which measure this song starts from", async () => {
    const { context, transportMessages } = loadBackground([{ id: 1, url: SONG_A, windowId: 1 }]);

    await context.sendTransportToSongsterr("play", 1, { songsterrUrl: SONG_A }, true, 0, 8);

    expect(transportMessages).toHaveLength(1);
    expect(transportMessages[0]).toMatchObject({ action: "play", resetBeforePlay: true, startMeasure: 8 });
  });

  it("reads the start measure off the current song, ignoring the ones that mean 'from the top'", () => {
    const { context } = loadBackground([]);

    expect(context.startMeasureForSong({ startMeasure: 8 })).toBe(8);
    expect(context.startMeasureForSong({ startMeasure: 8.4 })).toBe(8);
    expect(context.startMeasureForSong({ startMeasure: 1 })).toBe(0);
    expect(context.startMeasureForSong({ startMeasure: 0 })).toBe(0);
    expect(context.startMeasureForSong({ startMeasure: 5000 })).toBe(0);
    expect(context.startMeasureForSong({})).toBe(0);
    expect(context.startMeasureForSong(undefined)).toBe(0);
  });
});

describe("songKey / instrumentFromUrl / applyInstrument helpers", () => {
  it("treats the same song on different instruments as one song", () => {
    const { context } = loadBackground([]);
    expect(context.songKey(SONG_A_BASS)).toBe(context.songKey(SONG_A_DRUM));
    expect(context.songKey(SONG_A_BASS)).toBe(context.songKey(SONG_A_TAB));
    // The legacy "t<n>" track suffix collapses too.
    expect(context.songKey(`${SONG_A_TAB}t2`)).toBe(context.songKey(SONG_A_TAB));
  });

  it("distinguishes genuinely different songs", () => {
    const { context } = loadBackground([]);
    expect(context.songKey(SONG_A_TAB)).not.toBe(context.songKey(SONG_B_TAB));
  });

  // Songsterr canonicalizes the slug from the song id: a request for
  // ".../metallica-nothing-else-matters-tab-s437" lands on
  // ".../limp-bizkit-rollin-air-raid-vehicle-tab-s437" (observed on the live
  // site). Keying on the slug therefore called a member's own page a different
  // song and re-routed the player at the downbeat.
  it("identifies a song by its id, not its slug", () => {
    const { context } = loadBackground([]);
    expect(context.songKey("https://www.songsterr.com/a/wsa/whatever-tab-s437"))
      .toBe(context.songKey("https://www.songsterr.com/a/wsa/limp-bizkit-rollin-tab-s437"));
    expect(context.songKey("https://www.songsterr.com/a/wsa/same-slug-tab-s100"))
      .not.toBe(context.songKey("https://www.songsterr.com/a/wsa/same-slug-tab-s200"));
  });

  it("falls back to the path for a legacy URL carrying no song id", () => {
    const { context } = loadBackground([]);
    const url = "https://www.songsterr.com/a/wsa/test123-tab";
    expect(context.songKey(url)).toContain("test123");
  });

  it("reads the instrument category from the slug", () => {
    const { context } = loadBackground([]);
    expect(context.instrumentFromUrl(SONG_A_BASS)).toBe("bass");
    expect(context.instrumentFromUrl(SONG_A_DRUM)).toBe("drum");
    expect(context.instrumentFromUrl(SONG_A_TAB)).toBe("guitar");
  });

  it("rewrites a song URL across instruments", () => {
    const { context } = loadBackground([]);
    expect(context.applyInstrument(SONG_A_TAB, "bass")).toBe(SONG_A_BASS);
    expect(context.applyInstrument(SONG_A_TAB, "drum")).toBe(SONG_A_DRUM);
    expect(context.applyInstrument(SONG_A_BASS, "drum")).toBe(SONG_A_DRUM);
    expect(context.applyInstrument(SONG_A_BASS, "guitar")).toBe(SONG_A_TAB);
  });

  it("normalizes any existing track suffix away when applying an instrument", () => {
    const { context } = loadBackground([]);
    expect(context.applyInstrument(`${SONG_A_TAB}t3`, "guitar")).toBe(SONG_A_TAB);
    expect(context.applyInstrument(`${SONG_A_TAB}t3`, "bass")).toBe(SONG_A_BASS);
  });
});

describe("per-member instrument", () => {
  it("does not reload a member already on the song on a different instrument", async () => {
    const { context, created, updated } = loadBackground([
      { id: 1, url: SONG_A_BASS, windowId: 1 }
    ]);

    // Host advances to song A (guitar URL); member is already on A's bass tab.
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_TAB }, { active: true });

    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });

  it("opens a fresh tab on the explicitly chosen instrument, not the host's", async () => {
    const { context, created, sendRuntimeMessage } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    await sendRuntimeMessage({ type: "popupSetInstrument", instrument: "drum" });
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_TAB }, { active: true });

    expect(created).toHaveLength(1);
    expect(created[0].url).toBe(SONG_A_DRUM);
  });

  it("opens an explicit drum override as-is instead of rewriting the host URL", async () => {
    const { context, created, sendRuntimeMessage } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    await sendRuntimeMessage({ type: "popupSetInstrument", instrument: "drum" });
    await context.ensureSongsterrTabs({
      songsterrUrl: SONG_A_TAB,
      songsterrDrumUrl: SONG_A_EASY_DRUM
    }, { active: true });

    expect(created).toHaveLength(1);
    expect(created[0].url).toBe(SONG_A_EASY_DRUM);
  });

  it("does not reload a member already on an explicit alternate drum page", async () => {
    const { context, created, updated, sendRuntimeMessage } = loadBackground([
      { id: 1, url: SONG_A_EASY_DRUM, windowId: 1 }
    ]);

    await sendRuntimeMessage({ type: "popupSetInstrument", instrument: "drum" });
    await context.ensureSongsterrTabs({
      songsterrUrl: SONG_A_TAB,
      songsterrDrumUrl: SONG_A_EASY_DRUM
    }, { active: true });

    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });

  it("navigates a reusable tab to the explicitly chosen instrument", async () => {
    const { context, created, updated, sendRuntimeMessage } = loadBackground([
      { id: 1, url: SONG_B_TAB, windowId: 1 }
    ]);

    await sendRuntimeMessage({ type: "popupSetInstrument", instrument: "bass" });
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_TAB }, { active: true });

    expect(created).toHaveLength(0);
    expect(updated.some((u) => u.id === 1 && u.url === SONG_A_BASS)).toBe(true);
  });

  it("auto: inherits the instrument from the member's currently-open tab", async () => {
    // Default is "auto". The open tab is a bass tab for a different song, so
    // advancing to song A should land on song A's bass tab.
    const { context, updated } = loadBackground([
      { id: 1, url: SONG_B_BASS, windowId: 1 }
    ]);

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_TAB }, { active: true });

    expect(updated.some((u) => u.id === 1 && u.url === SONG_A_BASS)).toBe(true);
  });

  it("auto: uses an explicit alternate URL when the reusable tab reveals that instrument", async () => {
    const { context, updated } = loadBackground([
      { id: 1, url: SONG_B_BASS.replace("bass", "drum"), windowId: 1 }
    ]);

    await context.ensureSongsterrTabs({
      songsterrUrl: SONG_A_TAB,
      songsterrDrumUrl: SONG_A_EASY_DRUM
    }, { active: true });

    expect(updated.some((u) => u.id === 1 && u.url === SONG_A_EASY_DRUM)).toBe(true);
  });

  it("auto: uses the host URL verbatim when no Songsterr tab is open to detect from", async () => {
    const { context, created } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_BASS }, { active: true });

    expect(created[0].url).toBe(SONG_A_BASS);
  });

  it("explicit guitar normalizes a host bass URL down to the lead tab", async () => {
    const { context, created, sendRuntimeMessage } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    await sendRuntimeMessage({ type: "popupSetInstrument", instrument: "guitar" });
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_BASS }, { active: true });

    expect(created[0].url).toBe(SONG_A_TAB);
  });
});
