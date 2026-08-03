import { describe, expect, it } from "vitest";
import {
  GOTO_MEASURE_DISPATCH_CUSHION_MS,
  GOTO_MEASURE_TYPE_GAP_MS,
  gotoMeasureKeys,
  gotoMeasureLeadMs,
  keysForAction,
  playControlPath,
  type MuseScoreKeyConfig
} from "./musescore-keys.js";

const pressed = (strokes: Array<{ key: string }>) => strokes.map((stroke) => stroke.key);

// The helper's own defaults (parseArgs in musescore-windows.ts).
const config: MuseScoreKeyConfig = {
  playKey: " ",
  playFromSelectionKey: "+ ",
  resetKey: "^{HOME}",
  gotoMeasureKey: "^f",
  stopKey: "{ESC}",
  playMode: "stop-then-play"
};

describe("MuseScore key sequences", () => {
  it("stops, rewinds, and plays when the song starts at the top", () => {
    expect(pressed(keysForAction(config, "play", true))).toEqual(["{ESC}", "^{HOME}", "+ "]);
  });

  it("jumps through Find / Go to before the play key when the song starts later", () => {
    expect(pressed(keysForAction(config, "play", true, 8)))
      .toEqual(["{ESC}", "^{HOME}", "^f", "^a", "8", "{ENTER}", "+ "]);
  });

  it("keeps the play key last so only it waits for the downbeat", () => {
    const keys = pressed(keysForAction(config, "play", true, 12));
    expect(keys.at(-1)).toBe(config.playFromSelectionKey);
    expect(keys.slice(0, -1)).not.toContain(config.playFromSelectionKey);
  });

  it("starts from the cursor, not the playhead, so the measure jump is what plays", () => {
    // MuseScore's Find / Go to moves the *selection*; plain Play would resume
    // from wherever the playhead was last left.
    expect(pressed(keysForAction(config, "play", true, 8)).at(-1)).toBe("+ ");
    expect(pressed(keysForAction({ ...config, playFromSelectionKey: "" }, "play", true, 8)).at(-1))
      .toBe(" ");
  });

  it("clears the Find box before typing, so a previous jump cannot bleed in", () => {
    expect(pressed(gotoMeasureKeys(config, 8))).toEqual(["^f", "^a", "8", "{ENTER}"]);
  });

  it("types a multi-digit measure one digit at a time so it stays postable", () => {
    // The trigger posts each key as a single virtual key; "16" is not one, and a
    // sequence it cannot post falls back to the foreground path.
    expect(pressed(gotoMeasureKeys(config, 16))).toEqual(["^f", "^a", "1", "6", "{ENTER}"]);
    expect(pressed(gotoMeasureKeys(config, 128))).toEqual(["^f", "^a", "1", "2", "8", "{ENTER}"]);
    expect(pressed(gotoMeasureKeys(config, 16)).every((key) => /^(\^?[a-zA-Z0-9]|\{[A-Z]+\})$/.test(key)))
      .toBe(true);
  });

  it("treats every 'from the top' value as no jump at all", () => {
    for (const startMeasure of [undefined, 0, 1, -3, 1000, Number.NaN]) {
      expect(gotoMeasureKeys(config, startMeasure)).toEqual([]);
      expect(pressed(keysForAction(config, "play", true, startMeasure))).toEqual(["{ESC}", "^{HOME}", "+ "]);
      expect(gotoMeasureLeadMs(config, startMeasure, 120)).toBe(0);
    }
  });

  it("rounds a fractional measure the way the coordinator does", () => {
    expect(pressed(gotoMeasureKeys(config, 8.6))).toEqual(["^f", "^a", "9", "{ENTER}"]);
    expect(pressed(gotoMeasureKeys(config, 15.5))).toEqual(["^f", "^a", "1", "6", "{ENTER}"]);
  });

  it("leaves single-key play mode and Stop untouched", () => {
    expect(pressed(keysForAction({ ...config, playMode: "single-key" }, "play", true, 8)))
      .toEqual(["^{HOME}", "^f", "^a", "8", "{ENTER}", "+ "]);
    expect(pressed(keysForAction(config, "stop", false, 8))).toEqual(["{ESC}"]);
    expect(pressed(keysForAction(config, "play", false, 8))).toEqual(["{ESC}", " "]);
  });

  it("names the control path after what it actually did", () => {
    expect(playControlPath(config, true, 8)).toBe("stop-then-play+goto-measure");
    expect(playControlPath(config, true)).toBe("stop-then-play+reset-to-start");
    expect(playControlPath(config, false, 8)).toBe("stop-then-play");
  });

  it("honors a custom go-to-measure key", () => {
    expect(pressed(gotoMeasureKeys({ ...config, gotoMeasureKey: "^{F5}" }, 4)))
      .toEqual(["^{F5}", "^a", "4", "{ENTER}"]);
  });

  it("types into the Find box faster than it presses transport keys", () => {
    const [open, ...typed] = gotoMeasureKeys(config, 8);
    // The opening key has a panel to open; the rest are keystrokes into a text
    // field and must not spend a full command gap each.
    expect(open.gapMs).toBeUndefined();
    expect(typed.every((stroke) => stroke.gapMs === GOTO_MEASURE_TYPE_GAP_MS)).toBe(true);
  });

  it("budgets the count-in for exactly the gaps the jump adds, plus a cushion", () => {
    // The warm trigger paces every prefix key with the default gap, so the
    // budget covers that slower path rather than the shell path's short gaps.
    expect(gotoMeasureLeadMs(config, 8, 120)).toBe(4 * 120 + GOTO_MEASURE_DISPATCH_CUSHION_MS);
    // A two-digit measure is one more keystroke, and the budget follows it.
    expect(gotoMeasureLeadMs(config, 16, 120)).toBe(5 * 120 + GOTO_MEASURE_DISPATCH_CUSHION_MS);
  });
});
