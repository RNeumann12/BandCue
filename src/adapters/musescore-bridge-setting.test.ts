import { describe, expect, it } from "vitest";
import { bridgePortFromSetting, DEFAULT_BRIDGE_PORT } from "./musescore-bridge-setting.js";

describe("MuseScore bridge setting", () => {
  it("is on, at the default port, unless switched off", () => {
    expect(bridgePortFromSetting(undefined)).toBe(DEFAULT_BRIDGE_PORT);
    expect(bridgePortFromSetting("")).toBe(DEFAULT_BRIDGE_PORT);
    expect(bridgePortFromSetting("1")).toBe(DEFAULT_BRIDGE_PORT);
    expect(bridgePortFromSetting("true")).toBe(DEFAULT_BRIDGE_PORT);
    expect(bridgePortFromSetting("5050")).toBe(5050);
  });

  it("can be switched off", () => {
    for (const off of ["0", "false", "no", "OFF"]) {
      expect(bridgePortFromSetting(off)).toBeUndefined();
    }
  });
});
