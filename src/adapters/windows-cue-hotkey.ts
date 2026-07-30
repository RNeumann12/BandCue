import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A system-wide hotkey listener for an external cue (a Helix sending BandCue's
 * Play shortcut over USB).
 *
 * The host page can only see that keystroke while the browser holds the keyboard
 * focus -- and on a machine that also runs the MuseScore adapter, that focus is
 * exactly what MuseScore needs in order to be driven by keystrokes. The two
 * requirements cannot both hold, and the cue is the one that must never be
 * missed. `RegisterHotKey` takes the combination system-wide, so the cue arrives
 * whatever has focus, and MuseScore is free to keep it.
 *
 * The timestamp comes from the message's own `time` (the tick count when Windows
 * generated the input), not from when this process got round to handling it, so
 * the coordinator can anchor the count-in to the pedal's beat exactly as it does
 * for the host page's `event.timeStamp`.
 */

export interface CueHotkey {
  /** MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WIN, plus MOD_NOREPEAT. */
  modifiers: number;
  virtualKey: number;
  label: string;
}

const MOD_ALT = 0x0001;
const MOD_CONTROL = 0x0002;
const MOD_SHIFT = 0x0004;
const MOD_WIN = 0x0008;
// Without this, holding the cue key repeats it and re-requests Play all the way
// through the count-in.
const MOD_NOREPEAT = 0x4000;

const MODIFIER_BITS: Record<string, number> = {
  ctrl: MOD_CONTROL,
  control: MOD_CONTROL,
  alt: MOD_ALT,
  shift: MOD_SHIFT,
  win: MOD_WIN,
  meta: MOD_WIN
};

/**
 * Parses "ctrl+alt+p" into what RegisterHotKey wants. Returns undefined for
 * anything it cannot express, so a typo disables the listener loudly rather than
 * registering the wrong key.
 */
export function parseCueHotkey(value: string): CueHotkey | undefined {
  const parts = value.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  const keyPart = parts.at(-1) ?? "";
  let modifiers = MOD_NOREPEAT;
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part];
    if (!bit) {
      return undefined;
    }
    modifiers |= bit;
  }
  // A bare key would be swallowed system-wide, which is never what anyone wants.
  if (modifiers === MOD_NOREPEAT) {
    return undefined;
  }

  const virtualKey = virtualKeyFor(keyPart);
  if (virtualKey === undefined) {
    return undefined;
  }

  const label = parts
    .map((part) => (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join("+");
  return { modifiers, virtualKey, label };
}

function virtualKeyFor(key: string): number | undefined {
  if (/^[a-z]$/.test(key)) {
    return key.toUpperCase().charCodeAt(0);
  }
  if (/^[0-9]$/.test(key)) {
    return key.charCodeAt(0);
  }
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (functionKey) {
    // VK_F1 is 0x70 and the rest follow in order.
    return 0x70 + Number(functionKey[1]) - 1;
  }
  return undefined;
}

export function buildCueHotkeyScript(hotkey: CueHotkey): string {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BandCueHotKey {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
    public uint time; public int ptX; public int ptY;
  }
}
"@

if (-not [BandCueHotKey]::RegisterHotKey([IntPtr]::Zero, 1, ${hotkey.modifiers}, ${hotkey.virtualKey})) {
  [Console]::Out.WriteLine('{"type":"error","detail":"registration-failed"}')
  [Console]::Out.Flush()
  exit 1
}
[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.Flush()

$msg = New-Object BandCueHotKey+MSG
while ([BandCueHotKey]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -gt 0) {
  # WM_HOTKEY
  if ($msg.message -eq 0x0312) {
    # How long ago Windows generated the input, from the message's own tick
    # stamp. Tick counts are unsigned 32-bit and wrap; a wrapped or otherwise
    # implausible difference is reported as 0 rather than as a cue from the past.
    $nowTicks = [Environment]::TickCount64 -band 0xFFFFFFFF
    $ageMs = $nowTicks - [int64]$msg.time
    if ($ageMs -lt 0 -or $ageMs -gt 3000) { $ageMs = 0 }
    $cueAtLocal = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $ageMs
    [Console]::Out.WriteLine("{""type"":""cue"",""atLocal"":$cueAtLocal,""ageMs"":$ageMs}")
    [Console]::Out.Flush()
  }
}
`.trim();
}

export interface CueHotkeyEvents {
  onCue: (cueAtLocalMs: number, ageMs: number) => void;
  onReady?: (hotkey: CueHotkey) => void;
  onError?: (detail: string) => void;
}

/** Owns the listener process and restarts it if it dies. */
export class CueHotkeyListener {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private restartTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly hotkey: CueHotkey,
    private readonly events: CueHotkeyEvents,
    // Another process already owning the combination is a configuration problem,
    // not a transient one, so retries are slow enough to stay out of the way.
    private readonly restartDelayMs = 10_000,
    private readonly launch: (script: string) => ChildProcessWithoutNullStreams = (script) =>
      spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true })
  ) {}

  start(): void {
    if (this.stopped || this.child) {
      return;
    }

    try {
      const child = this.launch(buildCueHotkeyScript(this.hotkey));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
      child.on("error", (error) => this.handleExit(error.message));
      child.on("exit", () => this.handleExit("cue hotkey listener exited"));
      this.child = child;
    } catch (error) {
      this.handleExit(error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill();
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: { type?: string; atLocal?: number; ageMs?: number; detail?: string } | undefined;
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return;
    }

    if (parsed?.type === "cue" && Number.isFinite(parsed.atLocal)) {
      this.events.onCue(parsed.atLocal as number, Number(parsed.ageMs ?? 0));
      return;
    }
    if (parsed?.type === "ready") {
      this.events.onReady?.(this.hotkey);
      return;
    }
    if (parsed?.type === "error") {
      this.events.onError?.(parsed.detail ?? "unknown");
    }
  }

  private handleExit(detail: string): void {
    this.child = undefined;
    this.stdoutBuffer = "";
    if (this.stopped || this.restartTimer) {
      return;
    }
    this.events.onError?.(detail);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, this.restartDelayMs);
  }
}
