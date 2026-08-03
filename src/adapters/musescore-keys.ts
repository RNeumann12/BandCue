import { sanitizeStartMeasure } from "../shared/transport.js";

// The keystrokes the Windows MuseScore helper sends, kept apart from the helper
// itself so they can be reasoned about (and tested) without a room connection,
// a MuseScore window, or a PowerShell spawn.
//
// The order inside a list matters: everything but the **last** key is a prefix
// key, sent during the count-in while MuseScore is being activated. Only the
// final key waits for the scheduled downbeat.

export interface MuseScoreKeyConfig {
  playKey: string;
  /** MuseScore's `play-from-selection`; starts at the cursor rather than the playhead. */
  playFromSelectionKey?: string;
  resetKey: string;
  gotoMeasureKey: string;
  stopKey: string;
  playMode: "single-key" | "stop-then-play";
}

export interface MuseScoreKeyStroke {
  key: string;
  /** Pause after this key. Undefined means the helper's --command-gap-ms. */
  gapMs?: number;
}

// Typing into MuseScore's Find box needs far less settling time than a
// transport key does: it is a plain text field, and the box is already open by
// then. Measured on a real MuseScore 4, the default 120 ms gap per key made the
// setup overrun its lead time and the Play key fire ~90 ms late.
export const GOTO_MEASURE_TYPE_GAP_MS = 40;

/**
 * Keys that move MuseScore's cursor to a later measure. `^a` first because
 * MuseScore keeps the previous search text in the Find box: typing into it
 * would ask for measure "128" when the song wanted 8 after an earlier jump
 * to 12. The opening key keeps the normal gap — that one has a panel to open.
 */
export function gotoMeasureKeys(
  config: MuseScoreKeyConfig,
  startMeasure: number | undefined
): MuseScoreKeyStroke[] {
  const measure = sanitizeStartMeasure(startMeasure);
  if (!measure) {
    return [];
  }

  return [
    { key: config.gotoMeasureKey },
    { key: "^a", gapMs: GOTO_MEASURE_TYPE_GAP_MS },
    // One key per digit. The adapter's preferred path posts each keystroke into
    // MuseScore's message queue as a virtual key, and a virtual key is a single
    // character -- "16" is not one, so a two-digit measure made the whole
    // sequence unpostable and dropped the command onto the foreground path,
    // where it then failed outright. Typed digit by digit it stays postable, and
    // SendKeys types exactly the same number.
    ...String(measure).split("").map((digit) => ({ key: digit, gapMs: GOTO_MEASURE_TYPE_GAP_MS })),
    { key: "{ENTER}", gapMs: GOTO_MEASURE_TYPE_GAP_MS }
  ];
}

export function keysForAction(
  config: MuseScoreKeyConfig,
  action: "play" | "stop",
  resetBeforePlay = false,
  startMeasure: number | undefined = undefined
): MuseScoreKeyStroke[] {
  if (action === "stop") {
    return [{ key: config.stopKey }];
  }

  if (resetBeforePlay) {
    const prefixKeys = config.playMode === "stop-then-play"
      ? [{ key: config.stopKey }, { key: config.resetKey }]
      : [{ key: config.resetKey }];
    // MuseScore keeps the playback position separate from the selection: the
    // reset key (Ctrl+Home / `first-element`) moves the cursor and the view to the
    // top of the score, but plain Play still resumes from wherever the playhead
    // was last put -- which is why a reset looked like it "almost" worked, the
    // score scrolling back while playback carried on from the last click. The
    // action that starts at the cursor is `play-from-selection` (Shift+Space), so
    // a reset-before-play uses that instead. MuseScore's own `rewind` action
    // would also do it, but ships with no shortcut bound at all.
    //
    // A start measure rides on exactly that: Find / Go to moves the cursor, and
    // play-from-selection then starts there instead of at the top.
    return [
      ...prefixKeys,
      ...gotoMeasureKeys(config, startMeasure),
      { key: config.playFromSelectionKey || config.playKey }
    ];
  }

  if (config.playMode === "single-key") {
    return [{ key: config.playKey }];
  }

  return [{ key: config.stopKey }, { key: config.playKey }];
}

/**
 * How much longer the count-in has to start for this song's measure jump: the
 * gaps the extra keys add, plus a cushion for the key dispatches themselves.
 * Without it the jump eats into the lead time and the Play key fires late.
 *
 * Budgeted at the *default* gap for every key, not the shorter typing gap: the
 * warm trigger paces all prefix keys with one uniform gap, so this has to cover
 * the slower of the two paths.
 */
export function gotoMeasureLeadMs(
  config: MuseScoreKeyConfig,
  startMeasure: number | undefined,
  defaultGapMs: number
): number {
  const keys = gotoMeasureKeys(config, startMeasure);
  if (!keys.length) {
    return 0;
  }

  return keys.length * defaultGapMs + GOTO_MEASURE_DISPATCH_CUSHION_MS;
}

// Each extra SendWait costs more than the gap that follows it (the call itself,
// plus MuseScore reacting to it). Measured overrun on a real run was ~90 ms for
// four keys, so budget a little over that.
export const GOTO_MEASURE_DISPATCH_CUSHION_MS = 200;

export function playControlPath(
  config: MuseScoreKeyConfig,
  resetBeforePlay: boolean,
  startMeasure?: number
): string {
  if (!resetBeforePlay) {
    return config.playMode;
  }

  return sanitizeStartMeasure(startMeasure)
    ? `${config.playMode}+goto-measure`
    : `${config.playMode}+reset-to-start`;
}
