import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  GlobalHotkeyListener,
  buildGlobalHotkeyScript,
  parseCueHotkey,
  type GlobalHotkeyBinding
} from "./windows-cue-hotkey.js";

const bindings: GlobalHotkeyBinding[] = [
  { action: "play", hotkey: parseCueHotkey("ctrl+alt+p")! },
  { action: "stop", hotkey: parseCueHotkey("ctrl+alt+s")! }
];

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

describe("buildGlobalHotkeyScript", () => {
  it("registers every configured action and reports individual failures", () => {
    const script = buildGlobalHotkeyScript(bindings);
    expect(script).toContain('"type":"ready","action":"play"');
    expect(script).toContain('"type":"ready","action":"stop"');
    expect(script).toContain('"type":"error","action":"play","detail":"registration-failed"');
    expect(script).toContain("exit 1");
  });

  it("identifies the action that owns each Windows hotkey id", () => {
    const script = buildGlobalHotkeyScript(bindings);
    expect(script).toContain("$actions[1] = 'play'");
    expect(script).toContain("$actions[2] = 'stop'");
    expect(script).toContain('""action"":""$action""');
  });

  it("times the input from its event, not from when the script handled it", () => {
    const script = buildGlobalHotkeyScript(bindings);
    // A cue stamped at handling time would silently hand the coordinator the
    // scheduler's delay as if it were part of the count-in.
    expect(script).toContain("$ageMs = $nowTicks - [int64]$msg.time");
    expect(script).toContain("UnixTimeMilliseconds() - $ageMs");
  });

  it("discards an implausible tick difference rather than back-dating the cue", () => {
    const script = buildGlobalHotkeyScript(bindings);
    expect(script).toContain("if ($ageMs -lt 0 -or $ageMs -gt 3000) { $ageMs = 0 }");
  });
});

describe("GlobalHotkeyListener", () => {
  it("reports the action with the instant the input happened", () => {
    const onHotkey = vi.fn();
    const fake = createFakeProcess();
    const listener = new GlobalHotkeyListener(
      bindings,
      { onHotkey },
      10_000,
      () => fake.child
    );
    listener.start();

    fake.emit('{"type":"hotkey","action":"stop","atLocal":1785350071528,"ageMs":16}');
    expect(onHotkey).toHaveBeenCalledWith(bindings[1], 1785350071528, 16);
  });

  it("announces readiness so a silent failure to register is visible", () => {
    const onReady = vi.fn();
    const fake = createFakeProcess();
    const listener = new GlobalHotkeyListener(
      bindings,
      { onHotkey: vi.fn(), onReady },
      10_000,
      () => fake.child
    );
    listener.start();

    fake.emit('{"type":"ready","action":"play"}');
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({
      action: "play",
      hotkey: expect.objectContaining({ label: "Ctrl+Alt+P" })
    }));
  });

  it("reassembles a cue split across chunks", () => {
    const onHotkey = vi.fn();
    const fake = createFakeProcess();
    const listener = new GlobalHotkeyListener(
      bindings,
      { onHotkey },
      10_000,
      () => fake.child
    );
    listener.start();

    fake.emitRaw('{"type":"hotkey","action":"play","atLo');
    fake.emitRaw('cal":42,"ageMs":0}\n');
    expect(onHotkey).toHaveBeenCalledWith(bindings[0], 42, 0);
  });

  it("restarts a listener that dies, so the cue does not go missing for the night", () => {
    vi.useFakeTimers();
    try {
      const launch = vi.fn(() => createFakeProcess().child);
      const listener = new GlobalHotkeyListener(
        bindings,
        { onHotkey: vi.fn(), onError: vi.fn() },
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
      const listener = new GlobalHotkeyListener(
        bindings,
        { onHotkey: vi.fn() },
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
