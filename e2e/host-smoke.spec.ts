import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { readFile } from "node:fs/promises";

// Matches playwright.config.ts webServer env.
const PORT = 4599;
const TOKEN = "e2e-room-token";
const HOST_TOKEN = "e2e-host-token";
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
  // A real adapter measures its clock right after joining, and the host holds
  // Play until every device has (startBlockers). Report a converged estimate.
  adapter.send(JSON.stringify({ type: "clockStatus", rttMs: 5, offsetMs: 0, jitterMs: 1, sampleCount: 8 }));
  return adapter;
}

test("host connects, edits the setlist, and schedules a play", async ({ page }) => {
  await page.goto(`/host?token=${HOST_TOKEN}`);

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
  await page.goto(`/host?token=${HOST_TOKEN}`);
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
  await page.goto(`/host?token=${HOST_TOKEN}`);
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

/**
 * Play waits for every device: a device that has joined but not finished
 * syncing its clock holds Play, the host is told which device, and the
 * explicit override starts without it.
 */
test("play waits for a device that is still syncing, unless the host overrides", async ({ page }) => {
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));

  const synced = await joinFakeAdapter("E2E synced adapter");
  const syncing = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    syncing.once("open", () => resolve());
    syncing.once("error", reject);
  });
  syncing.send(JSON.stringify({
    type: "clientHello",
    deviceName: "E2E syncing adapter",
    role: "desktop-adapter",
    capabilities: [{ app: "mock", canPlay: true, canStop: true }]
  }));
  syncing.send(JSON.stringify({ type: "adapterStatus", ready: true, app: "mock" }));

  try {
    await expect(page.locator("#devices")).toContainText("E2E syncing adapter");
    await page.click("#armButton");

    await expect(page.locator("#playButton")).toBeDisabled();
    await expect(page.locator("#hostWarning")).toContainText("E2E syncing adapter is still syncing its clock");

    await page.check("#partialStartToggle");
    await expect(page.locator("#playButton")).toBeEnabled();

    await page.uncheck("#partialStartToggle");
    await expect(page.locator("#playButton")).toBeDisabled();

    // Once the device reports a converged clock, Play opens up by itself.
    syncing.send(JSON.stringify({ type: "clockStatus", rttMs: 5, offsetMs: 0, jitterMs: 1, sampleCount: 6 }));
    await expect(page.locator("#playButton")).toBeEnabled();

    // Leave the shared room disarmed for any test that follows.
    await page.click("#armButton");
  } finally {
    synced.close();
    syncing.close();
  }
});

/** Replaces the host's setlist with `titles` through the Import button. */
async function importSetlist(page: import("@playwright/test").Page, titles: string[], fileName = "e2e-setlist.json") {
  await page.locator("#importSetlistInput").setInputFiles({
    name: fileName,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      version: 2,
      songs: titles.map((title) => ({ id: `e2e-${title.toLowerCase().replaceAll(" ", "-")}`, title, sourceType: "other" }))
    }))
  });
  for (const title of titles) {
    await expect(page.locator("#setlistItems")).toContainText(title);
  }
}

async function roomSetlistTitles(page: import("@playwright/test").Page): Promise<string[]> {
  const response = await page.request.get("/api/room");
  const state = await response.json();
  return state.setlist.songs.map((song: { title: string }) => song.title);
}

test("a companion screen shows the room but none of the host controls", async ({ page }) => {
  await page.goto(`/?token=${TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));

  // `.host-panel { display: grid }` used to override the hidden attribute.
  await expect(page.locator("#hostPanel")).toBeHidden();
  await expect(page.locator("#playButton")).toBeHidden();
  await expect(page.locator("#setlistPanel")).toBeHidden();
  await expect(page.locator("#timingPanel")).toBeHidden();
});

test("setlist songs can be reordered, and a removal or an import undone", async ({ page }) => {
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await importSetlist(page, ["Order One", "Order Two", "Order Three"]);
  await expect.poll(() => roomSetlistTitles(page)).toEqual(["Order One", "Order Two", "Order Three"]);

  await page.getByRole("button", { name: "Move Order Three up" }).click();
  await expect.poll(() => roomSetlistTitles(page)).toEqual(["Order One", "Order Three", "Order Two"]);
  // The first song cannot move further up.
  await expect(page.getByRole("button", { name: "Move Order One up" })).toBeDisabled();

  await page.locator(".setlist-item", { hasText: "Order Three" }).getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => roomSetlistTitles(page)).toEqual(["Order One", "Order Two"]);
  await expect(page.locator("#setlistUndo")).toContainText("Removed Order Three");
  await page.click("#setlistUndoButton");
  await expect.poll(() => roomSetlistTitles(page)).toEqual(["Order One", "Order Three", "Order Two"]);
  await expect(page.locator("#setlistUndo")).toBeHidden();

  // Importing over an existing list is undoable too.
  await importSetlist(page, ["Replacement"], "other.json");
  await expect(page.locator("#setlistUndo")).toContainText("replacing 3");
  await page.click("#setlistUndoButton");
  await expect.poll(() => roomSetlistTitles(page)).toEqual(["Order One", "Order Three", "Order Two"]);

  // A broken file says so instead of failing silently.
  await page.locator("#importSetlistInput").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{not json")
  });
  await expect(page.locator("#setlistUndo")).toContainText("not valid JSON");
  await expect.poll(() => roomSetlistTitles(page)).toEqual(["Order One", "Order Three", "Order Two"]);
});

test("a reloaded host page picks up the room's current song", async ({ page }) => {
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await importSetlist(page, ["Reload One", "Reload Two", "Reload Three"]);

  await page.locator(".setlist-item", { hasText: "Reload Two" }).getByRole("button", { name: "Make Current" }).click();
  await expect(page.locator("#currentSongTitle")).toHaveText("Reload Two");

  await page.reload();
  await expect(page.locator(".setlist-item.current")).toContainText("Reload Two");
  await expect(page.locator("#readoutSong")).toHaveText("Reload Two");

  // Next moves on from the restored song, not from the top of the list.
  await page.click("#nextSongButton");
  await expect(page.locator("#currentSongTitle")).toHaveText("Reload Three");
});

test("a room link the coordinator rejects explains itself", async ({ page }) => {
  await page.goto("/host?token=not-the-room-token");
  await expect(page.locator("#connectionBanner")).toContainText("did not accept this room link", { timeout: 15_000 });
  await expect(page.locator("#playButton")).toBeDisabled();
});

test("host controls go offline while the connection is down and recover after", async ({ page }) => {
  let dropConnection = false;
  const routes: Array<import("@playwright/test").WebSocketRoute> = [];
  await page.routeWebSocket(/\/ws/, (ws) => {
    if (dropConnection) {
      ws.close();
      return;
    }
    routes.push(ws);
    ws.connectToServer();
  });

  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  const adapter = await joinFakeAdapter("E2E offline adapter");

  try {
    await page.click("#armButton");
    await expect(page.locator("#playButton")).toBeEnabled();

    dropConnection = true;
    for (const route of routes.splice(0)) {
      await route.close();
    }
    await expect(page.locator("#connectionBanner")).toContainText("Lost the connection");
    await expect(page.locator("#transportBadge")).toHaveText("Offline");
    await expect(page.locator("#playButton")).toBeDisabled();
    await expect(page.locator("#armButton")).toBeDisabled();

    dropConnection = false;
    await expect(page.locator("#connectionBanner")).toBeHidden({ timeout: 20_000 });
    await expect(page.locator("#playButton")).toBeEnabled();

    // Leave the shared room disarmed for any test that follows.
    await page.click("#armButton");
  } finally {
    adapter.close();
  }
});

test("a host page opened in a fresh browser adopts the room's setlist instead of wiping it", async ({ page, browser }) => {
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await importSetlist(page, ["Kept One", "Kept Two"]);
  await expect.poll(() => roomSetlistTitles(page)).toEqual(["Kept One", "Kept Two"]);

  // A second browser with no stored setlist, e.g. the band's other laptop.
  const fresh = await (await browser.newContext()).newPage();
  try {
    await fresh.goto(`/host?token=${HOST_TOKEN}`);
    await expect(fresh.locator("#setlistItems")).toContainText("Kept Two");
    await fresh.waitForTimeout(500);
    await expect.poll(() => roomSetlistTitles(page)).toEqual(["Kept One", "Kept Two"]);
  } finally {
    await fresh.context().close();
  }
});

test("a device can rename itself, and the host joins as Host", async ({ page, browser }) => {
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await expect(page.locator("#devices")).toContainText("Host");

  const phone = await (await browser.newContext()).newPage();
  try {
    await phone.goto(`/?token=${TOKEN}`);
    await expect(phone.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
    await phone.fill("#deviceNameInput", "Drums tablet");
    await phone.click("#deviceNameSaveButton");

    await expect(page.locator("#devices")).toContainText("Drums tablet");
    // Rejoining under the new name leaves no ghost of the old one behind.
    await expect(page.locator("#devices")).not.toContainText("Browser companion");
    await expect.poll(async () => {
      const state = await (await page.request.get("/api/room")).json();
      return state.clients.filter((client: { role: string }) => client.role === "companion")
        .map((client: { deviceName: string }) => client.deviceName);
    }).toEqual(["Drums tablet"]);

    // The name sticks across reloads.
    await phone.reload();
    await expect(phone.locator("#deviceNameInput")).toHaveValue("Drums tablet");
  } finally {
    await phone.context().close();
  }
});

test("the join panel copies the room link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await page.click("#copyLinkButton");
  await expect(page.locator("#copyLinkButton")).toHaveText("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`token=${TOKEN}`);
});

test("only the host link controls the room; the join link just follows it", async ({ page }) => {
  // A bandmate who scanned the QR code and opened /host with it.
  await page.goto(`/host?token=${TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await expect(page.locator("#hostDeniedBanner")).toBeVisible();
  await expect(page.locator("#hostPanel")).toBeHidden();
  await expect(page.locator("#setlistPanel")).toBeHidden();

  const state = await (await page.request.get("/api/room")).json();
  expect(state.clients.filter((client: { role: string }) => client.role === "host")).toEqual([]);
  // Nothing every device can read gives the host token away.
  expect(JSON.stringify(state)).not.toContain(HOST_TOKEN);
});

test("a second host page follows the first one's setlist edits", async ({ page, browser }) => {
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await importSetlist(page, ["Shared One", "Shared Two"]);

  const second = await (await browser.newContext()).newPage();
  try {
    await second.goto(`/host?token=${HOST_TOKEN}`);
    await expect(second.locator("#setlistItems")).toContainText("Shared Two");

    // An edit on the first host page reaches the second without a reload...
    await page.getByRole("button", { name: "Move Shared Two up" }).click();
    await expect(second.locator(".setlist-item").first()).toContainText("Shared Two");
    // ...and so does a change of the current song, from either side.
    await expect(second.locator(".setlist-item.current")).toContainText("Shared One");
    await second.locator(".setlist-item", { hasText: "Shared Two" }).getByRole("button", { name: "Make Current" }).click();
    await expect(page.locator(".setlist-item.current")).toContainText("Shared Two");
    await expect.poll(() => roomSetlistTitles(page)).toEqual(["Shared Two", "Shared One"]);
  } finally {
    await second.context().close();
  }
});
