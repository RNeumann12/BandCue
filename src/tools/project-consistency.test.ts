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
