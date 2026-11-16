import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import WebSocket from "ws";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Matches playwright.config.ts webServer env.
const PORT = 4599;
const TOKEN = "e2e-room-token";
const HOST_TOKEN = "e2e-host-token";
// The three-page example (see score-view-reading.spec.ts): 2 s a bar.
const EXPORT_DIR = join(import.meta.dirname, "../examples/score-view/export-multipage");
const manifest = JSON.parse(readFileSync(join(EXPORT_DIR, "manifest.json"), "utf8"));
const SCORE_ID: string = manifest.scoreId;
const FULL_SCORE_PAGES: string[] = manifest.parts[0].pages;
const SONG = { id: "network-song", title: "Network Song", sourceType: "musescore", source: "multipage-example.mscz" };

/**
 * The score view on a rehearsal room's Wi-Fi: requests that fail, requests
 * that never answer, a connection that drops in the middle of a song. The
 * notes on a music stand have to get through all three.
 */

async function joinRoom(token: string, hello: object): Promise<{ socket: WebSocket; clientId: string }> {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
  const clientId = await new Promise<string>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "serverHello") {
        resolve(message.clientId);
      }
    });
    socket.once("open", () => socket.send(JSON.stringify({ type: "clientHello", ...hello })));
  });
  return { socket, clientId };
}

/** A fake MuseScore helper with the export uploaded, and a host with the song current. */
async function setUpRoom(request: import("@playwright/test").APIRequestContext) {
  const helper = await joinRoom(TOKEN, {
    deviceName: "E2E MuseScore",
    role: "desktop-adapter",
    capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
  });
  helper.socket.send(JSON.stringify({ type: "clockStatus", rttMs: 5, offsetMs: 0, jitterMs: 1, sampleCount: 8 }));
  const files = [...manifest.parts.flatMap((part: { pages: string[]; timing: string; legend?: { file: string } }) =>
    [...part.pages, part.timing, ...(part.legend ? [part.legend.file] : [])]), "manifest.json"];
  for (const file of files) {
    const response = await request.put(`http://127.0.0.1:${PORT}/api/scores/${SCORE_ID}/${file}?token=${TOKEN}`, {
      headers: { "content-encoding": "gzip", "x-bandcue-client-id": helper.clientId },
      data: gzipSync(readFileSync(join(EXPORT_DIR, file)))
    });
    expect(response.status(), file).toBe(204);
  }

  const host = await joinRoom(HOST_TOKEN, { deviceName: "E2E host", role: "host", capabilities: [] });
  const send = (message: object) => host.socket.send(JSON.stringify({ updatedAt: Date.now(), requestedAt: Date.now(), ...message }));
  send({ type: "transportRequest", action: "stop" });
  send({ type: "setlistUpdate", songs: [SONG] });
  send({ type: "currentSongUpdate", song: SONG, index: 1, total: 1 });
  helper.socket.send(JSON.stringify({
    type: "adapterStatus", app: "musescore", ready: true,
    scores: [{ songId: SONG.id, relativePath: SONG.source, status: "ready", scoreId: SCORE_ID }]
  }));
  const close = () => {
    send({ type: "transportRequest", action: "stop" });
    host.socket.close();
    helper.socket.close();
  };
  return { send, close };
}

const thirdPage = (page: Page) => page.locator(".score-page").nth(2);
const naturalWidth = (page: Page) => thirdPage(page).locator("img")
  .evaluate((image: HTMLImageElement) => (image.complete ? image.naturalWidth : 0));

test("a page that failed to load is asked for again", async ({ page, request }) => {
  const room = await setUpRoom(request);
  let failing = true;
  let asked = 0;
  await page.route(new RegExp(`/api/scores/${SCORE_ID}/${FULL_SCORE_PAGES[2]}`), (route) => {
    asked += 1;
    return failing ? route.abort("connectionfailed") : route.continue();
  });

  try {
    await page.goto(`/?token=${TOKEN}`);
    await expect(page.locator("#scorePosition")).toHaveText(/^Bar 1 \//);
    await expect(page.locator("#scorePartSelect")).toHaveValue(/.+/);

    // The third page is only asked for when the reader gets near it.
    await thirdPage(page).scrollIntoViewIfNeeded();
    const note = thirdPage(page).locator(".score-page-retry");
    await expect(note).toHaveText("Page 3 – loading again…");
    await expect(thirdPage(page)).toHaveClass(/is-retrying/);
    expect(await naturalWidth(page)).toBe(0);

    // The Wi-Fi is back: nobody has to reload the page for the notes to appear.
    const askedWhileDown = asked;
    failing = false;
    await expect.poll(() => naturalWidth(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(note).toBeHidden();
    await expect(thirdPage(page)).not.toHaveClass(/is-retrying/);
    expect(askedWhileDown).toBeGreaterThan(0);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    room.close();
  }
});

test("a request for the notes that never answers is given up and tried again", async ({ page, request }) => {
  test.setTimeout(60_000);
  const room = await setUpRoom(request);
  let stalled = 0;
  await page.route(new RegExp(`/api/scores/${SCORE_ID}/manifest\\.json`), (route) => {
    if (stalled === 0) {
      // Swallowed by the Wi-Fi: no answer, no error.
      stalled += 1;
      return undefined;
    }
    return route.continue();
  });

  try {
    await page.goto(`/?token=${TOKEN}`);
    await expect(page.locator("#scoreMessage")).toHaveText("Loading the notes…");
    await expect(page.locator("#scoreMessage")).toContainText("did not answer in time", { timeout: 20_000 });
    // ...and the next try, three seconds later, brings them.
    await expect(page.locator("#scorePosition")).toHaveText(/^Bar 1 \//, { timeout: 15_000 });
    await expect(page.locator("#scoreMessage")).toBeHidden();
    expect(stalled).toBe(1);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    room.close();
  }
});

/**
 * A TCP proxy in front of the coordinator that can go silent without closing
 * anything -- a dropped Wi-Fi (see room-failures.spec.ts).
 */
async function startProxy(): Promise<{ port: number, freeze(): void, close(): Promise<void> }> {
  let frozen = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(PORT, "127.0.0.1");
    sockets.add(client).add(upstream);
    const forward = (from: net.Socket, to: net.Socket) => from.on("data", (chunk) => {
      if (!frozen) {
        to.write(chunk);
      }
    });
    forward(client, upstream);
    forward(upstream, client);
    upstream.on("close", () => {
      if (!frozen) {
        client.destroy();
      }
    });
    client.on("close", () => upstream.destroy());
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    freeze: () => { frozen = true; },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    })
  };
}

test("the pages of the song are already here when the connection drops", async ({ page, request }) => {
  test.setTimeout(60_000);
  const room = await setUpRoom(request);
  const proxy = await startProxy();

  try {
    await page.goto(`http://127.0.0.1:${proxy.port}/?token=${TOKEN}`);
    await expect(page.locator("#scorePosition")).toHaveText(/^Bar 1 \//);
    // Every page of the part has been fetched ahead, not only the first ones.
    await expect(page.locator("#scoreView")).toHaveAttribute("data-pages-fetched", "3/3", { timeout: 15_000 });

    proxy.freeze();
    // The player reads on to the last page with no network behind it.
    await thirdPage(page).scrollIntoViewIfNeeded();
    await expect.poll(() => naturalWidth(page), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(thirdPage(page).locator(".score-page-retry")).toBeHidden();
  } finally {
    await proxy.close();
    room.close();
  }
});

test("a reconnect in the middle of a song leaves the cursor where the band is", async ({ page, request }) => {
  test.setTimeout(60_000);
  const room = await setUpRoom(request);
  let connections = 0;
  let holdClock = false;
  let pageSide: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\?/, (route) => {
    connections += 1;
    pageSide = route;
    const server = route.connectToServer();
    server.onMessage((message) => {
      // The new connection's first clock answers are slow to come back.
      if (holdClock && typeof message === "string" && message.includes('"clockSyncResult"')) {
        return;
      }
      route.send(message);
    });
  });

  try {
    await page.goto(`/?token=${TOKEN}`);
    const view = page.locator("#scoreView");
    await expect(page.locator("#scorePosition")).toHaveText(/^Bar 1 \//);

    room.send({ type: "safetyUpdate", armed: true });
    room.send({ type: "transportRequest", action: "play" });
    await expect(view).toHaveAttribute("data-mode", "running", { timeout: 10_000 });
    await expect(page.locator("#scorePosition")).toHaveText(/^Bar 2 \//, { timeout: 10_000 });

    // The tablet's connection drops and comes back.
    holdClock = true;
    pageSide!.close();
    await expect.poll(() => connections, { timeout: 15_000 }).toBe(2);
    await expect(page.locator("body")).toHaveAttribute("data-connection", "open");

    // Connected again, but with no clock sample of the new connection yet.
    // The cursor used to fall back to the song's start bar here.
    const seen = new Set<string>();
    for (let sample = 0; sample < 12; sample += 1) {
      seen.add(`${await view.getAttribute("data-mode")}: ${await page.locator("#scorePosition").textContent()}`);
      await page.waitForTimeout(100);
    }
    expect([...seen].filter((entry) => !/^running: Bar [2-9]\d* \//.test(entry))).toEqual([]);

    holdClock = false;
    await expect(view).toHaveAttribute("data-mode", "running");
  } finally {
    room.close();
  }
});
