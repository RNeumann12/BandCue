import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// Matches playwright.config.ts webServer env.
const PORT = 4599;
const TOKEN = "e2e-room-token";
const HOST_TOKEN = "e2e-host-token";
const EXPORT_DIR = join(import.meta.dirname, "../examples/score-view/export");
const manifest = JSON.parse(readFileSync(join(EXPORT_DIR, "manifest.json"), "utf8"));
const SCORE_ID: string = manifest.scoreId;
const SONG = {
  id: "score-view-e2e",
  title: "Score View E2E",
  sourceType: "musescore",
  source: "timing-example.mscz",
  // Measure 3 is the first measure of the repeat (2 s a bar at 120 BPM).
  startMeasure: 3
};

/**
 * The score view end to end: a fake MuseScore helper uploads the committed
 * example export and reports it, the host plays from measure 3, and the
 * companion page must follow -- parked on the start measure during the
 * count-in, through the repeat while running, frozen after Stop.
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

function scoreUrl(file: string, token = TOKEN): string {
  return `http://127.0.0.1:${PORT}/api/scores/${SCORE_ID}/${file}?token=${token}`;
}

test("a companion reads along with the room's cursor", async ({ page, request }) => {
  const helper = await joinRoom(TOKEN, {
    deviceName: "E2E MuseScore",
    role: "desktop-adapter",
    capabilities: [{ app: "musescore", canPlay: true, canStop: true }]
  });
  helper.socket.send(JSON.stringify({ type: "clockStatus", rttMs: 5, offsetMs: 0, jitterMs: 1, sampleCount: 8 }));

  // Uploads need a connected desktop adapter's id; reads need the room token.
  const refused = await request.put(scoreUrl("manifest.json"), { data: "{}" });
  expect(refused.status()).toBe(403);
  expect((await request.get(scoreUrl("manifest.json", "wrong"))).status()).toBe(401);

  const files = [...manifest.parts.flatMap((part: { pages: string[]; timing: string }) => [...part.pages, part.timing]), "manifest.json"];
  for (const file of files) {
    const response = await request.put(scoreUrl(file), {
      headers: { "content-encoding": "gzip", "x-bandcue-client-id": helper.clientId },
      data: gzipSync(readFileSync(join(EXPORT_DIR, file)))
    });
    expect(response.status(), file).toBe(204);
  }
  const served = await request.get(scoreUrl("score-1.svg"));
  expect(served.headers()["cache-control"]).toContain("immutable");
  expect(await served.text()).toContain("<svg");

  const host = await joinRoom(HOST_TOKEN, { deviceName: "E2E host", role: "host", capabilities: [] });
  host.socket.send(JSON.stringify({ type: "transportRequest", action: "stop", requestedAt: Date.now() }));
  host.socket.send(JSON.stringify({ type: "setlistUpdate", songs: [SONG], updatedAt: Date.now() }));
  host.socket.send(JSON.stringify({ type: "currentSongUpdate", song: SONG, index: 1, total: 1, updatedAt: Date.now() }));
  helper.socket.send(JSON.stringify({
    type: "adapterStatus", app: "musescore", ready: true,
    scores: [{ songId: SONG.id, relativePath: SONG.source, status: "ready", scoreId: SCORE_ID }]
  }));

  await page.goto(`/?token=${TOKEN}`);
  const view = page.locator("#scoreView");
  await expect(view).toBeVisible();
  await expect(page.locator("#scoreTitle")).toHaveText(SONG.title);
  // Parked on the start measure before anything plays.
  await expect(page.locator("#scorePosition")).toHaveText("Bar 3 / 10");
  await expect(page.locator(".score-page img").first()).toHaveJSProperty("complete", true);
  await expect(page.locator("#scorePartSelect option")).toHaveText(["Full score", "Guitar", "Drums"]);

  // A companion opens on the notes, filling the screen; the room view is one tap away.
  await expect(page.locator("body")).toHaveClass(/score-focus/);
  await expect(page.locator("#roomCode")).toBeHidden();
  const viewport = page.viewportSize()!;
  expect(await view.boundingBox()).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  await page.click("#scoreFocusButton");
  await expect(page.locator("body")).not.toHaveClass(/score-focus/);
  await expect(page.locator("#roomCode")).toBeVisible();
  await page.click("#scoreFocusButton");
  await expect(page.locator("body")).toHaveClass(/score-focus/);

  host.socket.send(JSON.stringify({ type: "safetyUpdate", armed: true, updatedAt: Date.now() }));
  host.socket.send(JSON.stringify({ type: "transportRequest", action: "play", requestedAt: Date.now() }));
  await expect(view).toHaveAttribute("data-mode", "countdown");
  await expect(page.locator("#scoreCountdown")).toContainText("Starts in");
  await expect(page.locator("#scorePosition")).toHaveText("Bar 3 / 10");

  await expect(view).toHaveAttribute("data-mode", "running", { timeout: 10_000 });
  const cursorX = () => page.locator(".score-cursor").evaluate((cursor) =>
    Number(/translate3d\(([-\d.]+)px/.exec((cursor as HTMLElement).style.transform)?.[1]));
  const first = await cursorX();
  await expect.poll(cursorX).toBeGreaterThan(first);
  await expect(page.locator("#scorePosition")).toHaveText("Bar 4 / 10", { timeout: 5_000 });
  // The repeat sends the cursor back to measure 3 for a second time.
  await expect(page.locator("#scorePosition")).toHaveText("Bar 3 / 10 · 2nd time", { timeout: 5_000 });

  host.socket.send(JSON.stringify({ type: "transportRequest", action: "stop", requestedAt: Date.now() }));
  await expect(view).toHaveAttribute("data-mode", "stopped");
  const frozen = await cursorX();
  await page.waitForTimeout(600);
  expect(await cursorX()).toBe(frozen);

  host.socket.close();
  helper.socket.close();
});
