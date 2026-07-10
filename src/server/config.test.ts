import { describe, expect, it } from "vitest";
import { DEFAULT_COORDINATOR_PORT, parsePort } from "./config.js";

describe("server configuration", () => {
  it("uses the supplied fallback when the variable is absent", () => {
    expect(parsePort(undefined, "PORT")).toBe(DEFAULT_COORDINATOR_PORT);
    expect(parsePort(undefined, "DISCOVERY_PORT", 5000)).toBe(5000);
  });

  it("accepts trimmed ports across the valid range", () => {
    expect(parsePort(" 5000 ", "PORT")).toBe(5000);
    expect(parsePort("1", "PORT")).toBe(1);
    expect(parsePort("65535", "PORT")).toBe(65_535);
  });

  it.each(["", " ", "0", "-1", "1.5", "65536", "not-a-port"])(
    "rejects invalid port %j with a useful variable name",
    (value) => {
      expect(() => parsePort(value, "BANDCUE_DISCOVERY_PORT"))
        .toThrow(/BANDCUE_DISCOVERY_PORT must be an integer between 1 and 65535/u);
    }
  );
});
