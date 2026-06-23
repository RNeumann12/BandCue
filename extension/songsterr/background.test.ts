import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

const backgroundSource = readFileSync(
  fileURLToPath(new URL("./background.js", import.meta.url)),
  "utf8"
);

const SONG_A = "https://www.songsterr.com/a/wsa/song-a-s100";
const SONG_B = "https://www.songsterr.com/a/wsa/song-b-s200";
// Same song as SONG_A, pinned to different instruments (track tokens).
const SONG_A_T2 = "https://www.songsterr.com/a/wsa/song-a-s100t2";
const SONG_A_T3 = "https://www.songsterr.com/a/wsa/song-a-s100t3";
const SONG_A_Q2 = "https://www.songsterr.com/a/wsa/song-a-s100?track=2";

type FakeTab = { id: number; url: string; windowId: number; active?: boolean };

function loadBackground(initialTabs: FakeTab[]) {
  const created: Array<{ url: string; active?: boolean }> = [];
  const updated: Array<{ id: number; url?: string; active?: boolean }> = [];
  let nextId = 1000;
  const onUpdatedListeners = new Set<(id: number, info: any, tab: FakeTab) => void>();

  // Tabs created/updated report "complete" on the next tick so waitForTabReady resolves.
  const fireComplete = (tab: FakeTab) =>
    setTimeout(() => {
      for (const listener of [...onUpdatedListeners]) {
        listener(tab.id, { status: "complete" }, tab);
      }
    }, 0);

  const chrome = {
    runtime: { onMessage: { addListener() {} } },
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
      sendMessage: async () => ({ ok: true }),
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
    listeners: Record<string, Array<(evt: any) => void>> = {};
    constructor(public url: string) {
      sockets.push(this);
    }
    addEventListener(type: string, fn: (evt: any) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    send() {}
    close() {}
    emit(type: string, evt: any) {
      for (const fn of this.listeners[type] ?? []) fn(evt);
    }
  }

  const context: any = {
    chrome,
    setTimeout,
    clearTimeout,
    clearInterval,
    setInterval,
    URL,
    Date,
    JSON,
    Math,
    console,
    WebSocket: FakeSocket
  };
  vm.createContext(context);
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

  return { context, created, updated, deliverServerMessage };
}

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

describe("songKey / readTrack / applyTrack helpers", () => {
  it("treats the same song on different instruments as one song", () => {
    const { context } = loadBackground([]);
    expect(context.songKey(SONG_A_T2)).toBe(context.songKey(SONG_A_T3));
    expect(context.songKey(SONG_A_T2)).toBe(context.songKey(SONG_A));
    expect(context.songKey(SONG_A_Q2)).toBe(context.songKey(SONG_A));
  });

  it("distinguishes genuinely different songs", () => {
    const { context } = loadBackground([]);
    expect(context.songKey(SONG_A)).not.toBe(context.songKey(SONG_B));
  });

  it("does not strip a 't<n>' that is not the instrument suffix", () => {
    const { context } = loadBackground([]);
    const url = "https://www.songsterr.com/a/wsa/test123-s100";
    expect(context.songKey(url)).toContain("test123");
  });

  it("reads the instrument from each URL form", () => {
    const { context } = loadBackground([]);
    expect(context.readTrack(SONG_A_T2)).toEqual({ kind: "path", value: "2" });
    expect(context.readTrack(SONG_A_Q2)).toEqual({ kind: "query", value: "2" });
    expect(context.readTrack(SONG_A)).toBeNull();
  });

  it("prefers the path form when both are present", () => {
    const { context } = loadBackground([]);
    const both = "https://www.songsterr.com/a/wsa/song-a-s100t2?track=9";
    expect(context.readTrack(both)).toEqual({ kind: "path", value: "2" });
  });

  it("replaces an existing instrument token rather than appending", () => {
    const { context } = loadBackground([]);
    const out = context.applyTrack(SONG_A_T2, { kind: "path", value: "3" });
    expect(out).toBe(SONG_A_T3);
    expect(out).not.toContain("t2");
  });

  it("converts across forms and clears the other form", () => {
    const { context } = loadBackground([]);
    const out = context.applyTrack(SONG_A_T2, { kind: "query", value: "5" });
    expect(out).toContain("track=5");
    expect(new URL(out).pathname).toBe("/a/wsa/song-a-s100");
  });

  it("strips the instrument for a null descriptor", () => {
    const { context } = loadBackground([]);
    expect(context.applyTrack(SONG_A_T2, null)).toBe(SONG_A);
  });
});

describe("per-member instrument memory", () => {
  it("does not reload a member already on the song on a different instrument", async () => {
    const { context, created, updated } = loadBackground([
      { id: 1, url: SONG_A_T3, windowId: 1 }
    ]);

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_T2 }, { active: true });

    expect(created).toHaveLength(0);
    expect(updated.filter((u) => u.url)).toHaveLength(0);
  });

  it("opens a fresh tab on the member's remembered instrument, not the host's", async () => {
    const { context, created } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    context.rememberInstrumentFromUrl(SONG_A_T3);
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_T2 }, { active: true });

    expect(created).toHaveLength(1);
    expect(created[0].url).toBe(SONG_A_T3);
  });

  it("navigates a reusable tab to the member's remembered instrument", async () => {
    const { context, created, updated } = loadBackground([
      { id: 1, url: SONG_B, windowId: 1 }
    ]);

    context.rememberInstrumentFromUrl(SONG_A_T3);
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_T2 }, { active: true });

    expect(created).toHaveLength(0);
    expect(updated.some((u) => u.id === 1 && u.url === SONG_A_T3)).toBe(true);
  });

  it("uses the host URL verbatim when no instrument is remembered", async () => {
    const { context, created } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A_T2 }, { active: true });

    expect(created[0].url).toBe(SONG_A_T2);
  });

  it("does not let a transient bare song URL clobber a remembered instrument", async () => {
    const { context, created } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    context.rememberInstrumentFromUrl(SONG_A_T3);
    context.rememberInstrumentFromUrl(SONG_A); // no token -> must be ignored
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A }, { active: true });

    expect(created[0].url).toBe(SONG_A_T3);
  });

  it("remembers and re-applies the query-param instrument form", async () => {
    const { context, created } = loadBackground([
      { id: 9, url: "https://example.com/", windowId: 1 }
    ]);

    context.rememberInstrumentFromUrl(SONG_A_Q2);
    await context.ensureSongsterrTabs({ songsterrUrl: SONG_A }, { active: true });

    expect(created[0].url).toContain("track=2");
  });
});
