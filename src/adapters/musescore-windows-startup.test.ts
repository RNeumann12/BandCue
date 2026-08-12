import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("MuseScore Windows helper startup", () => {
  it("parses a configured global hotkey before rejecting a placeholder room", () => {
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "src/adapters/musescore-windows.ts",
      "--cue-hotkey",
      "ctrl+alt+p",
      "--stop-hotkey",
      "ctrl+alt+s",
      "--room",
      "http://HOST:4173/host?token=TOKEN"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still contains HOST/TOKEN placeholders");
    expect(result.stderr).not.toContain("ReferenceError");
    expect(result.error).toBeUndefined();
  });
});
