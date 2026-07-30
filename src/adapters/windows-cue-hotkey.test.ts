import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CueHotkeyListener, buildCueHotkeyScript, parseCueHotkey } from "./windows-cue-hotkey.js";

function createFakeProcess() {
  const stdout = new EventEmitter();
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdout: Object.assign(stdout, { setEncoding: () => stdout }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
    kill: () => undefined,
    exitCode: null
  });

  return {
    child,
    emit: (line: string) => stdout.emit("data", `${line}\n`),
    emitRaw: (chunk: string) => stdout.emit("data", chunk),
    exit: () => child.emit("exit", 0, null)
  };
}

describe("parseCueHotkey", () => {
  it("maps BandCue's Play shortcut to what RegisterHotKey wants", () => {
    // MOD_NOREPEAT 0x4000 | MOD_CONTROL 0x2 | MOD_ALT 0x1, VK_P 0x50.
    expect(parseCueHotkey("ctrl+alt+p")).toEqual({
      modifiers: 0x4003,
      virtualKey: 0x50,
      label: "Ctrl+Alt+P"
    });
  });

  it("supports function keys, which pedals often send instead of letters", () => {
    expect(parseCueHotkey("ctrl+f13")).toMatchObject({ virtualKey: 0x7c });
    expect(parseCueHotkey("shift+f1")).toMatchObject({ virtualKey: 0x70 });
  });

  it("rejects a combination with no modifier, which would swallow the key everywhere", () => {
    expect(parseCueHotkey("p")).toBeUndefined();
    expect(parseCueHotkey("f13")).toBeUndefined();
  });

  it("rejects typos rather than registering the wrong key", () => {
    expect(parseCueHotkey("crtl+alt+p")).toBeUndefined();
    expect(parseCueHotkey("ctrl+alt+enter")).toBeUndefined();
    expect(parseCueHotkey("")).toBeUndefined();
  });

  it("sets MOD_NOREPEAT so a held cue key cannot re-request play", () => {
    const hotkey = parseCueHotkey("ctrl+alt+p");
    expect((hotkey?.modifiers ?? 0) & 0x4000).toBe(0x4000);
  });
});

describe("buildCueHotkeyScript", () => {
  it("reports registration failure instead of pretending to listen", () => {
    const script = buildCueHotkeyScript(parseCueHotkey("ctrl+alt+p")!);
    expect(script).toContain('"type":"error","detail":"registration-failed"');
    expect(script).toContain("exit 1");
  });

  it("times the cue from the input event, not from when the script handled it", () => {
    const script = buildCueHotkeyScript(parseCueHotkey("ctrl+alt+p")!);
    // A cue stamped at handling time would silently hand the coordinator the
    // scheduler's delay as if it were part of the count-in.
    expect(script).toContain("$ageMs = $nowTicks - [int64]$msg.time");
    expect(script).toContain("UnixTimeMilliseconds() - $ageMs");
  });

  it("discards an implausible tick difference rather than back-dating the cue", () => {
    const script = buildCueHotkeyScript(parseCueHotkey("ctrl+alt+p")!);
    expect(script).toContain("if ($ageMs -lt 0 -or $ageMs -gt 3000) { $ageMs = 0 }");
  });
});

describe("CueHotkeyListener", () => {
  it("reports a cue with the instant the input happened", () => {
    const onCue = vi.fn();
    const fake = createFakeProcess();
    const listener = new CueHotkeyListener(
      parseCueHotkey("ctrl+alt+p")!,
      { onCue },
      10_000,
      () => fake.child
    );
    listener.start();

    fake.emit('{"type":"cue","atLocal":1785350071528,"ageMs":16}');
    expect(onCue).toHaveBeenCalledWith(1785350071528, 16);
  });

  it("announces readiness so a silent failure to register is visible", () => {
    const onReady = vi.fn();
    const fake = createFakeProcess();
    const listener = new CueHotkeyListener(
      parseCueHotkey("ctrl+alt+p")!,
      { onCue: vi.fn(), onReady },
      10_000,
      () => fake.child
    );
    listener.start();

    fake.emit('{"type":"ready"}');
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ label: "Ctrl+Alt+P" }));
  });

  it("reassembles a cue split across chunks", () => {
    const onCue = vi.fn();
    const fake = createFakeProcess();
    const listener = new CueHotkeyListener(
      parseCueHotkey("ctrl+alt+p")!,
      { onCue },
      10_000,
      () => fake.child
    );
    listener.start();

    fake.emitRaw('{"type":"cue","atLo');
    fake.emitRaw('cal":42,"ageMs":0}\n');
    expect(onCue).toHaveBeenCalledWith(42, 0);
  });

  it("restarts a listener that dies, so the cue does not go missing for the night", () => {
    vi.useFakeTimers();
    try {
      const launch = vi.fn(() => createFakeProcess().child);
      const listener = new CueHotkeyListener(
        parseCueHotkey("ctrl+alt+p")!,
        { onCue: vi.fn(), onError: vi.fn() },
        10_000,
        launch as unknown as (script: string) => ChildProcessWithoutNullStreams
      );
      listener.start();
      expect(launch).toHaveBeenCalledTimes(1);

      const firstChild = launch.mock.results[0]?.value as EventEmitter;
      firstChild.emit("exit", 0, null);
      vi.advanceTimersByTime(10_000);

      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops restarting once it has been stopped", () => {
    vi.useFakeTimers();
    try {
      const launch = vi.fn(() => createFakeProcess().child);
      const listener = new CueHotkeyListener(
        parseCueHotkey("ctrl+alt+p")!,
        { onCue: vi.fn() },
        10_000,
        launch as unknown as (script: string) => ChildProcessWithoutNullStreams
      );
      listener.start();
      listener.stop();

      const firstChild = launch.mock.results[0]?.value as EventEmitter;
      firstChild.emit("exit", 0, null);
      vi.advanceTimersByTime(60_000);

      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
