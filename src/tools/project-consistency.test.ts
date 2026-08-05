import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LAN_SCAN_SUBNETS, DEFAULT_ROOM_PORT } from "../shared/room-locator.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("cross-platform project metadata", () => {
  it("keeps release versions aligned", () => {
    const packageVersion = readJson<{ version: string }>("package.json").version;
    const extensionVersion = readJson<{ version: string }>("extension/songsterr/manifest.json").version;
    const androidGradle = read("android/app/build.gradle.kts");
    const androidVersion = requiredMatch(androidGradle, /versionName\s*=\s*"([^"]+)"/u, "Android versionName");

    expect(extensionVersion).toBe(packageVersion);
    expect(androidVersion).toBe(packageVersion);
  });

  it("keeps discovery ports and subnet lists aligned", () => {
    const extension = read("extension/songsterr/background.js");
    const extensionPermissions = read("extension/songsterr/room-permissions.js");
    const android = read("android/app/src/main/java/com/bandcue/songsterr/RoomLocator.kt");

    expect(Number(requiredMatch(extension, /const DEFAULT_ROOM_PORT\s*=\s*(\d+)/u, "extension port")))
      .toBe(DEFAULT_ROOM_PORT);
    expect(Number(requiredMatch(android, /const val DEFAULT_ROOM_PORT\s*=\s*(\d+)/u, "Android port")))
      .toBe(DEFAULT_ROOM_PORT);
    expect(Number(requiredMatch(
      extensionPermissions,
      /const DEFAULT_ROOM_PORT\s*=\s*(\d+)/u,
      "extension permissions port"
    ))).toBe(DEFAULT_ROOM_PORT);
    expect(extractStringList(extension, /const LAN_SCAN_SUBNETS\s*=\s*\[([\s\S]*?)\];/u, "extension subnets"))
      .toEqual(DEFAULT_LAN_SCAN_SUBNETS);
    expect(extractStringList(android, /val LAN_SCAN_SUBNETS\s*=\s*listOf\(([\s\S]*?)\)/u, "Android subnets"))
      .toEqual(DEFAULT_LAN_SCAN_SUBNETS);
  });

  it("delegates MuseScore song changes to the process-aware Windows helper", () => {
    const plugin = read("extension/musescore/bandcue.qml");
    const openSongBranch = plugin.indexOf('if (message.action === "open-song")');
    const transportClaim = plugin.indexOf('root.send({ type: "claim"', openSongBranch);

    expect(openSongBranch).toBeGreaterThan(-1);
    expect(transportClaim).toBeGreaterThan(openSongBranch);
    expect(plugin.slice(openSongBranch, transportClaim)).toContain(
      'controlPath: "musescore-plugin-delegated"'
    );
    expect(plugin).not.toContain("root.readScore(");
    expect(plugin).toContain('if (message.type === "retire")');
    expect(plugin).toContain("Qt.quit()");
    expect(plugin).toContain("root.parent.Window.window");
    expect(plugin).toContain("pluginWindow.showMinimized()");
  });

  // An attached plugin claims the play command, which suppresses the keyboard
  // path that knows how to drive MuseScore's Find / Go to. If the plugin ever
  // stops handling start measures itself, a bridged MuseScore silently plays
  // every song from the top again.
  it("keeps the MuseScore bridge in charge of the song's start measure", () => {
    const plugin = read("extension/musescore/bandcue.qml");
    const adapter = read("src/adapters/musescore-windows.ts");

    expect(plugin).toContain("function selectStartPoint(measureNumber)");
    expect(plugin).toContain("cursor.rewindToTick(measure.firstSegment.tick)");
    // Pre-positioned ahead of the downbeat, not during the count-in.
    expect(plugin).toContain('if (message.type === "prepare")');
    expect(plugin).toContain("function prepareStartPoint(");
    // And reported back, so a jump that falls short reaches the host.
    expect(plugin).toContain("result.startMeasure = root.pendingReachedMeasure");

    expect(adapter).toContain("startMeasure: command.startMeasure");
    expect(adapter).toContain("function prepareBridgeStartMeasure(");
  });
});

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(read(relativePath)) as T;
}

function requiredMatch(value: string, pattern: RegExp, label: string): string {
  const match = value.match(pattern)?.[1];
  if (match === undefined) {
    throw new Error(`Could not read ${label}.`);
  }
  return match;
}

function extractStringList(value: string, pattern: RegExp, label: string): string[] {
  return [...requiredMatch(value, pattern, label).matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}
