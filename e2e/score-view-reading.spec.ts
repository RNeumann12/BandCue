import { expect, test, type Page } from "@playwright/test";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { untilDrawing } from "./drawing.js";

// Matches playwright.config.ts webServer env.
const PORT = 4599;
const TOKEN = "e2e-room-token";
const HOST_TOKEN = "e2e-host-token";
// examples/score-view/multipage-example.mscz exported by MuseScore 4.7.5: the
// timing example on three pages, with rehearsal marks Intro (bar 2), Verse
// (bar 3) and Chorus (bar 6), a repeat of bars 3-4 and D.S. al Coda.
const EXPORT_DIR = join(import.meta.dirname, "../examples/score-view/export-multipage");
const manifest = JSON.parse(readFileSync(join(EXPORT_DIR, "manifest.json"), "utf8"));
const timing = JSON.parse(readFileSync(join(EXPORT_DIR, "score.timing.json"), "utf8"));
const SCORE_ID: string = manifest.scoreId;
// A "ready" export whose timing never arrived.
const BROKEN_ID = "be".repeat(16);

const VERSE = { id: "reading-verse", title: "Reading Verse", sourceType: "musescore", source: "multipage-example.mscz", startMeasure: 4 };
const MISSING = { id: "reading-missing", title: "Reading Missing", sourceType: "musescore", source: "missing.mscz" };
const BROKEN = { id: "reading-broken", title: "Reading Broken", sourceType: "musescore", source: "broken.mscz" };
const TOP = { id: "reading-top", title: "Reading Top", sourceType: "musescore", source: "multipage-example.mscz" };
const SONGS = [VERSE, MISSING, BROKEN, TOP];

async function joinRoom(token: string, hello: object): Promise<{ socket: WebSocket; clientId: string; states: any[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
  const states: any[] = [];
  const clientId = await new Promise<string>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "serverHello") {
        resolve(message.clientId);
      } else if (message.type === "roomState") {
        states.push(message);
      }
    });
    socket.once("open", () => socket.send(JSON.stringify({ type: "clientHello", ...hello })));
  });
  return { socket, clientId, states };
}

function fileUrl(scoreId: string, file: string): string {
  return `http://127.0.0.1:${PORT}/api/scores/${scoreId}/${file}?token=${TOKEN}`;
}

/** A fake MuseScore helper with the multi-page export uploaded and the setlist's scores reported. */
async function setUpRoom(request: import("@playwright/test").APIRequestContext) {
  const helper = await joinRoom(TOKEN, {
    deviceName: "E2E MuseScore",
    role: "desktop-adapter",
    capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
  });
  helper.socket.send(JSON.stringify({ type: "clockStatus", rttMs: 5, offsetMs: 0, jitterMs: 1, sampleCount: 8 }));
  const files = [...manifest.parts.flatMap((part: { pages: string[]; timing: string }) => [...part.pages, part.timing]), "manifest.json"];
  for (const file of files) {
    const response = await request.put(fileUrl(SCORE_ID, file), {
      headers: { "content-encoding": "gzip", "x-bandcue-client-id": helper.clientId },
      data: gzipSync(readFileSync(join(EXPORT_DIR, file)))
    });
    expect([204]).toContain(response.status());
  }
  await request.put(fileUrl(BROKEN_ID, "manifest.json"), {
    headers: { "x-bandcue-client-id": helper.clientId },
    data: Buffer.from(JSON.stringify({ ...manifest, scoreId: BROKEN_ID }))
  });

  const host = await joinRoom(HOST_TOKEN, { deviceName: "E2E host", role: "host", capabilities: [] });
  const send = (message: object) => host.socket.send(JSON.stringify({ updatedAt: Date.now(), requestedAt: Date.now(), ...message }));
  send({ type: "transportRequest", action: "stop" });
  send({ type: "setlistUpdate", songs: SONGS });
  send({ type: "currentSongUpdate", song: VERSE, index: 1, total: SONGS.length });
  helper.socket.send(JSON.stringify({
    type: "adapterStatus", app: "musescore", ready: true,
    scores: [
      { songId: VERSE.id, relativePath: VERSE.source, status: "ready", scoreId: SCORE_ID },
      { songId: MISSING.id, relativePath: MISSING.source, status: "missing", detail: "No score file matched." },
      { songId: BROKEN.id, relativePath: BROKEN.source, status: "ready", scoreId: BROKEN_ID },
      { songId: TOP.id, relativePath: TOP.source, status: "ready", scoreId: SCORE_ID }
    ]
  }));
  const close = () => {
    host.socket.close();
    helper.socket.close();
  };
  return { host, helper, send, close };
}

/** Sets a control inside the folded View panel. */
async function setControl(page: Page, selector: string, value: string | boolean) {
  await page.locator(selector).evaluate((element, next) => {
    const input = element as HTMLInputElement;
    if (typeof next === "boolean") {
      input.checked = next;
    } else {
      input.value = next;
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

const cursorX = (page: Page) => page.locator(".score-cursor").evaluate((cursor) =>
  Number(/translate3d\(([-\d.]+)px/.exec((cursor as HTMLElement).style.transform)?.[1]));
const cursorPage = (page: Page) => page.locator(".score-cursor").evaluate((cursor) =>
  (cursor.parentElement as HTMLElement).dataset.page);

test("a companion reads a multi-page score: sections, count-in, page following, another song", async ({ page, request }) => {
  test.setTimeout(60_000);
  const room = await setUpRoom(request);
  await page.goto(`/?token=${TOKEN}`);
  const view = page.locator("#scoreView");
  const position = page.locator("#scorePosition");

  // Parked on bar 4 with its section; bar 4 is followed by a repeat; the next
  // song has no notes, and says so before it is called.
  await expect(position).toHaveText("Bar 4 / 10 · Verse");
  await expect(page.locator("#scoreJump")).toHaveText("↻ back to bar 3");
  await expect(page.locator("#scoreNext")).toHaveText("Next: Reading Missing · no notes");
  await expect(page.locator("#scoreNext")).toHaveAttribute("data-status", "missing");
  await expect(page.locator(".score-page")).toHaveCount(3);
  // Only the first pages load up front; the cursor's neighbours are made eager.
  expect(await page.locator(".score-page img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).loading)))
    .toEqual(["eager", "eager", "eager"]);

  // The cursor runs a second ahead; a Stop must freeze it there, not jump back.
  await setControl(page, "#scoreLeadInput", "1000");

  await untilDrawing(page);
  room.send({ type: "safetyUpdate", armed: true });
  room.send({ type: "transportRequest", action: "play" });
  await expect(page.locator("#scoreCountdown")).toHaveText(/^Count-in [1-4]$/);
  await expect(page.locator("#scoreAnnounce")).toHaveText("Count-in. Starting at bar 4.");
  await expect(view).toHaveAttribute("data-mode", "running", { timeout: 10_000 });

  // Through the repeat and onto page 2: the cursor moves there and the view follows.
  await expect(position).toHaveText("Bar 3 / 10 · Verse · 2nd time", { timeout: 6_000 });
  await expect(position).toHaveText("Bar 5 / 10 · Verse", { timeout: 8_000 });
  expect(await cursorPage(page)).toBe("1");
  await expect.poll(() => page.evaluate(() => {
    const cursor = document.querySelector(".score-cursor")!.getBoundingClientRect();
    const scroller = document.querySelector("#scoreScroller")!.getBoundingClientRect();
    return cursor.top >= scroller.top && cursor.bottom <= scroller.bottom;
  })).toBe(true);

  // The host moves on while the band still plays the old song: the new song
  // waits on its start instead of running from the old song's downbeat.
  room.send({ type: "currentSongUpdate", song: TOP, index: 4, total: SONGS.length });
  await expect(page.locator("#scoreTitle")).toHaveText(TOP.title);
  await expect(view).toHaveAttribute("data-mode", "elsewhere");
  await expect(page.locator("#scoreCountdown")).toHaveText("Band is on another song");
  await page.waitForTimeout(1_200);
  await expect(position).toHaveText("Bar 1 / 10");
  // Back on the song that plays, its cursor is where the band is.
  room.send({ type: "currentSongUpdate", song: VERSE, index: 1, total: SONGS.length });
  await expect(view).toHaveAttribute("data-mode", "running");
  await expect(position).toHaveText(/Bar (5|6|7) \/ 10/);

  const before = await cursorX(page);
  const barBefore = await position.textContent();
  room.send({ type: "transportRequest", action: "stop" });
  await expect(view).toHaveAttribute("data-mode", "stopped");
  const after = await cursorX(page);
  if ((await position.textContent()) === barBefore) {
    expect(after).toBeGreaterThanOrEqual(before - 1);
  }
  await page.waitForTimeout(400);
  expect(await cursorX(page)).toBe(after);

  // Looking around while nothing plays: turning or resizing the screen keeps
  // the place the player scrolled to.
  const scroller = page.locator("#scoreScroller");
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(200);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width, height: viewport.height - 60 });
  await page.waitForTimeout(400);
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await page.setViewportSize(viewport);

  // A song whose export cannot load shows no other song's notes, and the next
  // song loads at once, not after the failed one's retry delay.
  room.send({ type: "currentSongUpdate", song: BROKEN, index: 3, total: SONGS.length });
  await expect(page.locator("#scoreMessage")).toHaveText("Could not load the notes: HTTP 404");
  await expect(page.locator(".score-page")).toHaveCount(0);
  await expect(position).toHaveText("");
  room.send({ type: "currentSongUpdate", song: TOP, index: 4, total: SONGS.length });
  await expect(position).toHaveText("Bar 1 / 10", { timeout: 1_500 });
  await expect(page.locator("#scoreMessage")).toBeHidden();

  room.close();
});

test("page turns, night mode and a screen that stays on", async ({ page, request }) => {
  const room = await setUpRoom(request);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator("#scorePosition")).toHaveText("Bar 4 / 10 · Verse");

  // Night mode: light notes on dark pages.
  await setControl(page, "#scoreNightInput", true);
  await expect(page.locator("#scoreView")).toHaveClass(/is-night/);
  expect(await page.locator(".score-page img").first().evaluate((image) => getComputedStyle(image).filter)).toContain("invert");
  await setControl(page, "#scoreNightInput", false);

  // Page turns on a landscape screen: two pages, numbered.
  await setControl(page, "#scoreLayoutSelect", "pages");
  await expect(page.locator("#scorePageTurnLabel")).toBeVisible({ visible: false });
  const shown = () => page.locator(".score-page.is-shown").evaluateAll((pages) =>
    pages.sort((a, b) => Number((a as HTMLElement).style.order) - Number((b as HTMLElement).style.order))
      .map((element) => element.querySelector(".score-page-number")!.textContent));
  await expect.poll(shown).toEqual(["1", "2"]);
  await expect(page.locator(".score-page.is-shown .score-page-number").first()).toBeVisible();

  // A swipe to the left turns to the next pages.
  const box = (await page.locator("#scoreScroller").boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.6, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(shown).toEqual(["3", "2"]);
  // Whole-page turns keep book order.
  await setControl(page, "#scorePageTurnSelect", "whole");
  await expect.poll(shown).toEqual(["3"]);
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(shown).toEqual(["1", "2"]);
  await setControl(page, "#scorePageTurnSelect", "half");
  await setControl(page, "#scoreLayoutSelect", "scroll");

  // The screen is kept on once the player has touched the page.
  await page.locator("#scoreTitle").click();
  await expect.poll(() => page.locator("#scoreView").getAttribute("data-keep-awake")).toMatch(/^(lock|video)$/);
  room.close();
});

test("without a wake lock (plain http), a looping video keeps the screen on after a tap", async ({ page, request }) => {
  const room = await setUpRoom(request);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "wakeLock", { get: () => undefined, configurable: true });
  });
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator("#scorePosition")).toHaveText("Bar 4 / 10 · Verse");
  await page.locator("#scoreTitle").click();
  await expect.poll(() => page.locator("#scoreView").getAttribute("data-keep-awake")).toBe("video");
  await expect.poll(() => page.locator("video.keep-awake-video").evaluate((video) => !(video as HTMLVideoElement).paused)).toBe(true);
  await expect(page.locator("#scoreAwake")).toBeHidden();
  // Leaving "notes only" lets the screen sleep again.
  await page.click("#scoreFocusButton");
  await expect.poll(() => page.locator("#scoreView").getAttribute("data-keep-awake")).toBe("off");
  expect(await page.locator("video.keep-awake-video").evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true);
  room.close();
});

test("the host taps a bar to make it the song's start", async ({ page, request }) => {
  const room = await setUpRoom(request);
  await page.goto(`/host?token=${HOST_TOKEN}`);
  const view = page.locator("#scoreView");
  await expect(view).toBeVisible();
  // The host page folds the notes away until asked.
  await page.click("#scoreCollapseButton");
  await expect(page.locator("#scorePosition")).toHaveText("Bar 4 / 10 · Verse");

  await page.click("#scorePickStartButton");
  await expect(page.locator("#scorePickStartButton")).toHaveText("Tap a bar…");
  await expect(view).toHaveClass(/is-picking/);
  // Bar 7 sits on page 2.
  const measure = timing.measures[6];
  const pageSize = timing.pages[measure.page];
  const target = page.locator(`.score-page[data-page="${measure.page}"]`);
  // Into the score's own scroller's view (and the host page's).
  await target.evaluate((element, y) => {
    const scroller = document.querySelector("#scoreScroller") as HTMLElement;
    const page = element as HTMLElement;
    scroller.scrollTop = page.offsetTop + y * page.clientHeight - 120;
    scroller.scrollIntoView({ block: "center" });
  }, measure.y / pageSize.height);
  await page.waitForTimeout(200);
  const bounds = (await target.boundingBox())!;
  await page.mouse.click(
    bounds.x + (measure.x + measure.w / 2) / pageSize.width * bounds.width,
    bounds.y + (measure.y + measure.h / 2) / pageSize.height * bounds.height
  );
  await expect(view).not.toHaveClass(/is-picking/);
  await expect(page.locator("#scorePosition")).toHaveText("Bar 7 / 10 · Chorus");
  await expect.poll(() => room.host.states.at(-1)?.currentSong?.song?.startMeasure).toBe(7);
  await expect.poll(() => room.host.states.at(-1)?.setlist?.songs?.find((song: { id: string }) => song.id === VERSE.id)?.startMeasure).toBe(7);
  room.close();
});
