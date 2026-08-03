import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { readFile } from "node:fs/promises";

// Matches playwright.config.ts webServer env.
const PORT = 4599;
const TOKEN = "e2e-room-token";
const ROOM_CODE = "E2E0FF";

/**
 * Browser-level smoke test for the host workflow. Everything here runs against
 * the real coordinator and the real served host page, so it covers the wiring
 * that unit tests structurally can't: DOM ids ↔ app.js ↔ WebSocket ↔ room.
 * A fake desktop adapter joins over a raw WebSocket so Play becomes available
 * without any real Songsterr/MuseScore.
 */
async function joinFakeAdapter(name: string): Promise<WebSocket> {
  const adapter = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    adapter.once("open", () => resolve());
    adapter.once("error", reject);
  });
  adapter.send(JSON.stringify({
    type: "clientHello",
    deviceName: name,
    role: "desktop-adapter",
    capabilities: [{ app: "mock", canPlay: true, canStop: true }]
  }));
  adapter.send(JSON.stringify({ type: "adapterStatus", ready: true, app: "mock" }));
  return adapter;
}

test("host connects, edits the setlist, and schedules a play", async ({ page }) => {
  await page.goto(`/host?token=${TOKEN}`);

  // Connected: the coordinator's serverHello/roomState reached the page.
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));

  // Setlist round trip: form -> localStorage/room -> rendered list.
  await page.fill("#songTitleInput", "E2E Smoke Song");
  await page.fill("#songTempoInput", "92");
  await page.click("#setlistSubmitButton");
  await expect(page.locator("#setlistItems")).toContainText("E2E Smoke Song");
  await expect(page.locator("#setlistItems")).toContainText("92% tempo");

  const downloadPromise = page.waitForEvent("download");
  await page.click("#exportSetlistButton");
  const download = await downloadPromise;
  const exportPath = await download.path();
  expect(exportPath).toBeTruthy();
  const exported = JSON.parse(await readFile(exportPath!, "utf8"));
  expect(exported).toMatchObject({ version: 2, songs: [{ title: "E2E Smoke Song", tempoPercent: 92 }] });

  // A fake ready adapter joins; without one, Play stays blocked.
  const adapter = await joinFakeAdapter("E2E fake adapter");

  try {
    await expect(page.locator("#devices")).toContainText("E2E fake adapter");

    // Arm, then Play schedules a downbeat in the room.
    await page.click("#armButton");
    await expect(page.locator("#playButton")).toBeEnabled();
    await page.click("#playButton");

    await expect
      .poll(async () => {
        const response = await page.request.get("/api/room");
        const state = await response.json();
        return state.transport.status;
      })
      .toMatch(/scheduled|running/);

    // Stop returns the room to idle so the run leaves no scheduled transport.
    await expect(page.locator("#stopButton")).toBeEnabled();
    await page.click("#stopButton");
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/room");
        const state = await response.json();
        return state.transport.status;
      })
      .toBe("stopped");
  } finally {
    adapter.close();
  }
});

/**
 * A song that starts at a later measure. The host form is the only place the
 * measure is entered, and the adapters read it off the play command, so this
 * covers the whole path from the input to what a real adapter would receive.
 */
test("a start measure entered on the host reaches the adapters' play command", async ({ page }) => {
  await page.goto(`/host?token=${TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));

  await page.fill("#songTitleInput", "Measure Eight Song");
  await page.fill("#songStartMeasureInput", "8");
  await page.click("#setlistSubmitButton");
  await expect(page.locator("#setlistItems")).toContainText("from measure 8");

  await page.locator(".setlist-item", { hasText: "Measure Eight Song" })
    .getByRole("button", { name: "Make Current" })
    .click();
  await expect(page.locator("#currentSongMeta")).toContainText("from measure 8");

  const adapter = await joinFakeAdapter("E2E measure adapter");
  const commands: Array<Record<string, any>> = [];
  adapter.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "transportCommand") {
      commands.push(message);
    }
  });

  try {
    await expect(page.locator("#devices")).toContainText("E2E measure adapter");
    await page.click("#armButton");
    await expect(page.locator("#playButton")).toBeEnabled();
    await page.click("#playButton");

    await expect.poll(() => commands.find((command) => command.action === "play")?.currentSong?.song?.startMeasure)
      .toBe(8);

    // An adapter that had to start from the top is called out, not left to be
    // discovered by ear.
    adapter.send(JSON.stringify({
      type: "adapterStatus",
      ready: true,
      app: "mock",
      lastCommand: {
        action: "play",
        sequenceId: commands.find((command) => command.action === "play")?.sequenceId,
        status: "succeeded",
        at: Date.now(),
        startMeasure: 1
      }
    }));
    await expect(page.locator("#warnings")).toContainText("started from measure 1, not 8");

    await page.click("#stopButton");
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/room");
        const state = await response.json();
        return state.transport.status;
      })
      .toBe("stopped");
  } finally {
    adapter.close();
  }
});

/**
 * The two setlist-automation switches next to Arm/Play/Stop. Both songs are
 * one second long and carry no openable source, so the room's own auto-duration
 * stop ends each one and the runner has nothing to wait for a tab to load.
 */
test("auto-load and auto-start carry the setlist into the next song", async ({ page }) => {
  await page.goto(`/host?token=${TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));

  for (const title of ["Auto Song A", "Auto Song B"]) {
    await page.fill("#songTitleInput", title);
    await page.fill("#songDurationInput", "0:01");
    await page.click("#setlistSubmitButton");
    await expect(page.locator("#setlistItems")).toContainText(title);
  }

  await page.check("#autoAdvanceToggle");
  await expect(page.locator("#autoStartToggle")).toBeEnabled();
  await expect(page.locator("#autoStartToggle")).toBeChecked();
  await expect(page.locator("#autoRunStatus")).toContainText("start it");

  const adapter = await joinFakeAdapter("E2E automation adapter");

  try {
    await expect(page.locator("#devices")).toContainText("E2E automation adapter");

    // Start song A by hand; the end of it is what the automation reacts to.
    await page.locator(".setlist-item", { hasText: "Auto Song A" })
      .getByRole("button", { name: "Make Current" })
      .click();
    await expect(page.locator("#currentSongTitle")).toHaveText("Auto Song A");
    await page.click("#armButton");
    await expect(page.locator("#playButton")).toBeEnabled();
    await page.click("#playButton");

    // A ends after its second, so the host advances to B and starts it too.
    await expect(page.locator("#currentSongTitle")).toHaveText("Auto Song B", { timeout: 15_000 });
    await expect(page.locator("#autoRunStatus")).toContainText("Auto Song B");
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/room");
        const state = await response.json();
        return state.transport.status;
      }, { timeout: 15_000 })
      .toMatch(/scheduled|running/);

    // The last song ends the chain instead of wrapping around to the first.
    await expect(page.locator("#autoRunStatus")).toHaveText("Setlist finished.", { timeout: 15_000 });
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/room");
        const state = await response.json();
        return state.transport.status;
      })
      .toBe("stopped");
  } finally {
    adapter.close();
  }
});
