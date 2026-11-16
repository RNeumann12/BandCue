import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import WebSocket from "ws";
import net from "node:net";

// Matches playwright.config.ts webServer env.
const PORT = 4599;
const TOKEN = "e2e-room-token";
const HOST_TOKEN = "e2e-host-token";
const ROOM_CODE = "E2E0FF";

/**
 * What the host page does when things go wrong: the Wi-Fi swallows the
 * connection, the room turns a request down, a second host page is open, the
 * room and the devices disagree about what is playing. host-smoke.spec.ts
 * covers the path where everything works.
 *
 * This file sorts after host-smoke on purpose: every spec shares the one room,
 * and host-smoke's first test expects to find the setlist it wrote alone.
 */

async function joinFakeAdapter(name: string, status: Record<string, unknown> = {}): Promise<WebSocket> {
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
  adapter.send(JSON.stringify({ type: "adapterStatus", ready: true, app: "mock", ...status }));
  adapter.send(JSON.stringify({ type: "clockStatus", rttMs: 5, offsetMs: 0, jitterMs: 1, sampleCount: 8 }));
  return adapter;
}

async function roomState(page: Page): Promise<Record<string, any>> {
  const response = await page.request.get(`http://127.0.0.1:${PORT}/api/room`);
  return response.json();
}

/**
 * A TCP proxy in front of the coordinator that can go silent: it keeps every
 * socket open but passes nothing on, in either direction. That is what a
 * dropped Wi-Fi looks like to a browser -- no FIN, no reset, just no more data.
 */
async function startProxy(): Promise<{ port: number, freeze(): void, thaw(): void, close(): Promise<void> }> {
  let frozen = false;
  const pairs = new Set<{ client: net.Socket, upstream: net.Socket }>();
  const server = net.createServer((client) => {
    const upstream = net.connect(PORT, "127.0.0.1");
    const pair = { client, upstream };
    pairs.add(pair);
    const forward = (from: net.Socket, to: net.Socket) => from.on("data", (chunk) => {
      if (!frozen) {
        to.write(chunk);
      }
    });
    forward(client, upstream);
    forward(upstream, client);
    const drop = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    // While silent, the coordinator giving up on the client must not reach it.
    upstream.on("close", () => {
      if (!frozen) {
        drop();
      }
    });
    client.on("close", drop);
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dropAll = () => {
    for (const pair of [...pairs]) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
    pairs.clear();
  };
  return {
    port: (server.address() as net.AddressInfo).port,
    freeze: () => { frozen = true; },
    // The network is back: what was in flight is gone, new connections work.
    thaw: () => {
      frozen = false;
      dropAll();
    },
    close: () => new Promise<void>((resolve) => {
      dropAll();
      server.close(() => resolve());
    })
  };
}

test("a connection that dies without a word is noticed within seconds", async ({ page }) => {
  test.setTimeout(60_000);
  const proxy = await startProxy();

  try {
    await page.goto(`http://127.0.0.1:${proxy.port}/host?token=${HOST_TOKEN}`);
    await expect(page.locator("body")).toHaveAttribute("data-connection", "open");
    await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
    await expect(page.locator("#armButton")).toBeEnabled();

    proxy.freeze();
    // The heartbeat allows 6 s of silence and looks every 2 s. Waiting for the
    // browser to finish closing the dead socket took 68 s.
    await expect(page.locator("body")).toHaveAttribute("data-connection", "offline", { timeout: 12_000 });
    await expect(page.locator("#connectionBanner")).toContainText("Lost the connection");
    await expect(page.locator("#transportBadge")).toHaveText("Offline");
    await expect(page.locator("#armButton")).toBeDisabled();
    await expect(page.locator("#playButton")).toBeDisabled();

    proxy.thaw();
    await expect(page.locator("body")).toHaveAttribute("data-connection", "open", { timeout: 25_000 });
    await expect(page.locator("#connectionBanner")).toBeHidden();
    await expect(page.locator("#armButton")).toBeEnabled();
  } finally {
    await proxy.close();
  }
});

test("what the room says stays on screen, and one bad message does not stop the page", async ({ page }) => {
  let toPage: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\?/, (route) => {
    route.connectToServer();
    toPage = route;
  });
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await expect.poll(() => Boolean(toPage)).toBe(true);

  // A refusal from the room. Room states keep arriving (every clock report
  // sends one) and used to wipe the message within a second.
  toPage!.send(JSON.stringify({ type: "error", message: "E2E: the room said no." }));
  const notice = page.locator("#notices .notice", { hasText: "E2E: the room said no." });
  await expect(notice).toBeVisible();
  await page.waitForTimeout(3_000);
  await expect(notice).toBeVisible();
  await expect(page.locator("#subline")).not.toContainText("E2E");

  // The host who looked up too late finds it under "Recent messages".
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await page.locator("#recentMessages summary").click();
  await expect(page.locator("#recentMessagesList")).toContainText("E2E: the room said no.");

  // A room state this page cannot render: it says so, and carries on with the
  // next one instead of standing still.
  await expect(page.locator("#pageProblemBanner")).toBeHidden();
  toPage!.send(JSON.stringify({
    type: "roomState",
    roomCode: "BROKEN",
    clients: null,
    transport: { status: "stopped", sequenceId: 0 },
    setlist: { songs: [] },
    safety: {}
  }));
  await expect(page.locator("#pageProblemBanner")).toBeVisible();
  await expect(page.locator("#pageProblemText")).toContainText("This page hit a problem");

  const adapter = await joinFakeAdapter("E2E after-the-problem adapter");
  try {
    await expect(page.locator("#devices")).toContainText("E2E after-the-problem adapter");
    await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  } finally {
    adapter.close();
  }

  await page.click("#pageProblemDismissButton");
  await expect(page.locator("#pageProblemBanner")).toBeHidden();
});

test("the host can stop devices the room does not know are playing", async ({ page }) => {
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  expect((await roomState(page)).transport.status).toBe("stopped");

  // Stopped room, nothing known to play: Stop is there, but quiet.
  await expect(page.locator("#stopButton")).toBeEnabled();
  await expect(page.locator("#stopButton")).toHaveText("Stop");
  await expect(page.locator("#stopButton")).toHaveAttribute("data-idle", "true");

  // What a coordinator restart mid-song leaves behind: a stopped room and a
  // device that is still playing.
  const adapter = await joinFakeAdapter("E2E still-playing adapter", { playback: "playing" });
  const commands: Array<Record<string, any>> = [];
  adapter.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "transportCommand") {
      commands.push(message);
    }
  });

  try {
    await expect(page.locator("#devices")).toContainText("E2E still-playing adapter");
    await expect(page.locator("#stopButton")).toHaveText("Stop all");
    await expect(page.locator("#stopButton")).toHaveAttribute("data-idle", "false");

    await page.click("#stopButton");
    await expect.poll(() => commands.map((command) => command.action)).toEqual(["stop"]);
    expect((await roomState(page)).transport).toMatchObject({ status: "stopped", stopReason: "manual" });

    adapter.send(JSON.stringify({ type: "adapterStatus", ready: true, app: "mock", playback: "stopped" }));
    await expect(page.locator("#stopButton")).toHaveText("Stop");
  } finally {
    adapter.close();
  }
});

/**
 * Two host pages (the laptop and the host's phone), both with auto-load and
 * auto-start on. Each runs the automation. The second page's "arm, then play"
 * used to arm the room after the first page's Play had already disarmed it --
 * and its own Play was turned down -- so the song ran with the room armed and
 * ended that way: one stray hotkey from starting again.
 */
test("two host pages auto-start the next song once and leave the room disarmed", async ({ page, context }) => {
  test.setTimeout(60_000);
  const second = await context.newPage();
  await page.goto(`/host?token=${HOST_TOKEN}`);
  await second.goto(`/host?token=${HOST_TOKEN}`);
  await expect(page.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));
  await expect(second.locator("#roomCode")).toHaveText(new RegExp(ROOM_CODE));

  for (const title of ["Two Hosts A", "Two Hosts B"]) {
    await page.fill("#songTitleInput", title);
    await page.fill("#songDurationInput", "0:01");
    await page.click("#setlistSubmitButton");
    await expect(page.locator("#setlistItems")).toContainText(title);
    // The other host page takes the room's list.
    await expect(second.locator("#setlistItems")).toContainText(title);
  }

  await page.check("#autoAdvanceToggle");
  await second.check("#autoAdvanceToggle");
  await expect(page.locator("#autoStartToggle")).toBeChecked();
  await expect(second.locator("#autoStartToggle")).toBeChecked();

  const adapter = await joinFakeAdapter("E2E two-hosts adapter");
  const plays: number[] = [];
  adapter.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "transportCommand" && message.action === "play") {
      plays.push(message.sequenceId);
    }
  });

  try {
    await expect(page.locator("#devices")).toContainText("E2E two-hosts adapter");
    // In an empty room the first song added is current already.
    const makeCurrent = page.locator(".setlist-item", { hasText: "Two Hosts A" })
      .getByRole("button", { name: "Make Current" });
    if (await makeCurrent.count()) {
      await makeCurrent.click();
    }
    await expect(page.locator("#currentSongTitle")).toHaveText("Two Hosts A");
    await expect(second.locator("#currentSongTitle")).toHaveText("Two Hosts A");
    await page.click("#armButton");
    await expect(page.locator("#playButton")).toBeEnabled();
    await page.click("#playButton");

    // A ends by itself; both pages move on to B and ask for it.
    await expect(page.locator("#currentSongTitle")).toHaveText("Two Hosts B", { timeout: 15_000 });
    await expect
      .poll(async () => {
        const state = await roomState(page);
        return state.currentSong?.song?.title === "Two Hosts B" ? state.transport.status : "waiting";
      }, { timeout: 15_000 })
      .toMatch(/scheduled|running/);

    // B was started once, and the room is not armed while it plays...
    expect((await roomState(page)).safety.armed).toBe(false);
    await expect(page.locator("#autoRunStatus")).toHaveText("Setlist finished.", { timeout: 15_000 });
    await expect(second.locator("#autoRunStatus")).toHaveText("Setlist finished.", { timeout: 15_000 });

    // ...nor after it.
    const after = await roomState(page);
    expect(after.transport.status).toBe("stopped");
    expect(after.safety.armed).toBe(false);
    expect(plays).toHaveLength(2);
  } finally {
    adapter.close();
    await second.close();
  }
});
