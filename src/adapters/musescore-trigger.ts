import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A long-lived PowerShell that keeps MuseScore ready to receive its Play key.
 *
 * The one-shot alternative -- spawn powershell.exe, load the SendKeys/AppActivate
 * assemblies, scan every process, activate the window, send the reset prefix,
 * then wait for the downbeat -- costs ~2 s on a real machine, and all of it lands
 * *inside* the count-in. A room synced to an external timeline (Helix) cannot
 * absorb that: one 4/4 measure at 128 BPM is 1875 ms, so the coordinator either
 * holds the whole band back to fit the setup or MuseScore fires late.
 *
 * This process is started once and kept warm, so the count-in no longer pays for
 * the shell launch or the assembly load -- by far the largest part of the cost.
 *
 * What it deliberately does *not* do is foreground MuseScore ahead of the cue.
 * On a Helix rig the cue arrives as a keystroke, so whatever holds the keyboard
 * focus receives it; taking the foreground early would send the cue into
 * MuseScore instead of the host page and the Play would never be requested.
 * Activation and the reset key therefore stay inside `fire`, where they belong,
 * and `resolve` only looks the window up.
 */

export interface MuseScoreTriggerConfig {
  processMatch: string;
  titleMatch?: string;
  activationRetries: number;
  activationDelayMs: number;
  commandGapMs: number;
}

/** A keystroke expressed the way PostMessage needs it. */
export interface PostableKey {
  virtualKey: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /**
   * Whether this is a Windows "extended" key (the grey navigation cluster, the
   * arrows, right Ctrl/Alt). Their lParam must carry bit 24, otherwise the target
   * reads the numeric-keypad twin instead -- and a shortcut like Ctrl+Home then
   * never matches, which is how a silently-ignored reset key looks.
   */
  extended: boolean;
  /** The original SendKeys token, for status messages. */
  token: string;
}

// VK codes Windows classes as extended. Left out deliberately: VK_RCONTROL and
// VK_RMENU, since modifiers are posted as the side-agnostic VK_CONTROL/VK_MENU.
const EXTENDED_VIRTUAL_KEYS = new Set([
  0x21, // VK_PRIOR (Page Up)
  0x22, // VK_NEXT (Page Down)
  0x23, // VK_END
  0x24, // VK_HOME
  0x25, // VK_LEFT
  0x26, // VK_UP
  0x27, // VK_RIGHT
  0x28, // VK_DOWN
  0x2d, // VK_INSERT
  0x2e, // VK_DELETE
  0x90 // VK_NUMLOCK
]);

const VK_BY_NAME: Record<string, number> = {
  esc: 0x1b,
  escape: 0x1b,
  home: 0x24,
  end: 0x23,
  tab: 0x09,
  enter: 0x0d,
  space: 0x20,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  pgup: 0x21,
  pgdn: 0x22
};

/**
 * Converts one SendKeys token (`" "`, `"{ESC}"`, `"^{HOME}"`) into a virtual key
 * plus modifiers, so it can be posted straight to MuseScore's window instead of
 * typed into whatever holds the keyboard focus.
 *
 * Returns undefined for anything it cannot express, and the caller then keeps the
 * SendKeys path for that key rather than guessing.
 */
export function parseSendKeysToken(token: string): PostableKey | undefined {
  let rest = token;
  let ctrl = false;
  let alt = false;
  let shift = false;

  // Modifier prefixes may repeat and combine: "^%+{HOME}".
  for (;;) {
    const prefix = rest[0];
    if (prefix === "^") {
      ctrl = true;
    } else if (prefix === "%") {
      alt = true;
    } else if (prefix === "+") {
      shift = true;
    } else {
      break;
    }
    rest = rest.slice(1);
  }

  let virtualKey: number | undefined;
  const named = /^\{([A-Za-z0-9]+)\}$/.exec(rest);
  if (named) {
    const name = named[1].toLowerCase();
    const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(name);
    virtualKey = functionKey ? 0x70 + Number(functionKey[1]) - 1 : VK_BY_NAME[name];
  } else if (rest === " ") {
    virtualKey = 0x20;
  } else if (/^[a-zA-Z0-9]$/.test(rest)) {
    virtualKey = rest.toUpperCase().charCodeAt(0);
  }

  if (virtualKey === undefined) {
    return undefined;
  }
  return {
    virtualKey,
    ctrl,
    alt,
    shift,
    extended: EXTENDED_VIRTUAL_KEYS.has(virtualKey),
    token
  };
}

/** Parses every key, or nothing: a partly-postable sequence must not be split. */
export function parseSendKeysTokens(tokens: string[]): PostableKey[] | undefined {
  const parsed: PostableKey[] = [];
  for (const token of tokens) {
    const key = parseSendKeysToken(token);
    if (!key) {
      return undefined;
    }
    parsed.push(key);
  }
  return parsed;
}

export interface TriggerResolveResult {
  ok: boolean;
  error?: string;
  processId?: number;
  processName?: string;
  windowTitle?: string;
  resolvedAtLocal?: number;
}

export interface TriggerFireResult {
  ok: boolean;
  error?: string;
  /**
   * When activation and the prefix keys finished, i.e. when only the timed wait
   * was left. Anything after `dueLocalAt` means the lead time was too short.
   */
  readyAtLocal?: number;
  firedAtLocal?: number;
  processId?: number;
  processName?: string;
  windowTitle?: string;
  /** Which mechanism delivered the keys: posted to the window, or typed into it. */
  delivery?: "post" | "sendkeys";
}

interface TriggerResponse extends TriggerResolveResult, TriggerFireResult {
  id?: number;
}

// Win32 + assemblies the loop needs, loaded once for the process's whole life
// instead of once per command. Mirrors SENDKEYS_ASSEMBLY_PREAMBLE in
// musescore-windows.ts; kept separate so this module stands alone.
const PREAMBLE = `
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BandCueWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("winmm.dll")]
  public static extern uint timeBeginPeriod(uint uMilliseconds);
  [DllImport("winmm.dll")]
  public static extern uint timeEndPeriod(uint uMilliseconds);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint MapVirtualKey(uint uCode, uint uMapType);
}
"@
`.trim();

function escapeSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * The resident loop. Reads one JSON request per line from stdin and writes one
 * JSON response per line to stdout, so Node can hand it a downbeat without
 * paying for a process launch.
 */
export function buildTriggerScript(config: MuseScoreTriggerConfig): string {
  return `
${PREAMBLE}
try { (Get-Process -Id $PID).PriorityClass = 'High' } catch {}
# Held for the process's whole life: every fire ends in a sub-tick wait, and
# re-entering this per command would itself cost part of what we are saving.
[void][BandCueWin32]::timeBeginPeriod(1)
$script:processMatch = '${escapeSingleQuoted(config.processMatch)}'
$script:titleMatch = '${escapeSingleQuoted(config.titleMatch ?? "")}'
$script:target = $null

function Get-BandCueNow { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Resolve-BandCueTarget {
  Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match $script:processMatch) -and
      (-not $script:titleMatch -or $_.MainWindowTitle -match $script:titleMatch)
  } | Sort-Object -Property StartTime -Descending | Select-Object -First 1
}

function Confirm-BandCueForeground($proc) {
  if ($null -eq $proc) { return $false }
  $foreground = [BandCueWin32]::GetForegroundWindow()
  [uint32]$foregroundProcessId = 0
  [BandCueWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) | Out-Null
  return ($foregroundProcessId -eq $proc.Id)
}

function Enable-BandCueTarget($proc, $retries, $delayMs) {
  for ($attempt = 0; $attempt -lt $retries; $attempt++) {
    if (Confirm-BandCueForeground $proc) { return $true }
    [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) | Out-Null
    Start-Sleep -Milliseconds $delayMs
    if (Confirm-BandCueForeground $proc) { return $true }
  }
  return $false
}

function Send-BandCueKeys($keys, $gapMs) {
  foreach ($key in @($keys)) {
    if (-not $key) { continue }
    [System.Windows.Forms.SendKeys]::SendWait($key)
    if ($gapMs -gt 0) { Start-Sleep -Milliseconds $gapMs }
  }
}

# Posts one keystroke straight into a window's message queue. Unlike SendKeys,
# this needs no foreground window -- which matters because Windows only lets a
# process take the foreground under narrow conditions that a background adapter
# does not meet, so activating MuseScore is not something we can rely on.
function Post-BandCueKey($hwnd, $key) {
  $vk = [uint32]$key.virtualKey
  $scan = [BandCueWin32]::MapVirtualKey($vk, 0)
  # Bit 24 marks an extended key. Without it Home/End/arrows read as their
  # numeric-keypad twins, and a shortcut such as Ctrl+Home never matches.
  $extended = if ($key.extended) { 0x01000000 } else { 0 }
  $down = [IntPtr](1 -bor ($scan -shl 16) -bor $extended)
  $up = [IntPtr](1 -bor ($scan -shl 16) -bor $extended -bor 0xC0000000)
  $modifiers = @()
  # VK_CONTROL 0x11, VK_MENU 0x12, VK_SHIFT 0x10
  if ($key.ctrl) { $modifiers += 0x11 }
  if ($key.alt) { $modifiers += 0x12 }
  if ($key.shift) { $modifiers += 0x10 }

  foreach ($modifier in $modifiers) {
    $modifierScan = [BandCueWin32]::MapVirtualKey([uint32]$modifier, 0)
    [void][BandCueWin32]::PostMessage($hwnd, 0x0100, [IntPtr]$modifier, [IntPtr](1 -bor ($modifierScan -shl 16)))
  }
  [void][BandCueWin32]::PostMessage($hwnd, 0x0100, [IntPtr]$vk, $down)
  [void][BandCueWin32]::PostMessage($hwnd, 0x0101, [IntPtr]$vk, $up)
  # Released in reverse, so a queue read mid-sequence never sees a stuck modifier.
  [array]::Reverse($modifiers)
  foreach ($modifier in $modifiers) {
    $modifierScan = [BandCueWin32]::MapVirtualKey([uint32]$modifier, 0)
    [void][BandCueWin32]::PostMessage($hwnd, 0x0101, [IntPtr]$modifier, [IntPtr](1 -bor ($modifierScan -shl 16) -bor 0xC0000000))
  }
}

function Post-BandCueKeys($hwnd, $keys, $gapMs) {
  foreach ($key in @($keys)) {
    if ($null -eq $key) { continue }
    Post-BandCueKey $hwnd $key
    if ($gapMs -gt 0) { Start-Sleep -Milliseconds $gapMs }
  }
}

function Write-BandCueResponse($response) {
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $trimmed = $line.Trim()
  if (-not $trimmed) { continue }
  $request = $null
  try { $request = $trimmed | ConvertFrom-Json } catch { $request = $null }
  if ($null -eq $request) { continue }

  $response = [ordered]@{ id = $request.id; ok = $false }
  try {
    if ($request.cmd -eq 'ping') {
      $response.ok = $true
    }
    elseif ($request.cmd -eq 'resolve') {
      # Look the window up without touching the foreground: on a Helix rig the
      # cue is a keystroke, and stealing focus here would take it away from the
      # page that has to receive it.
      $script:target = Resolve-BandCueTarget
      if ($null -eq $script:target) {
        $response.error = 'no-musescore-window'
      }
      else {
        $response.ok = $true
        $response.processId = $script:target.Id
        $response.processName = $script:target.ProcessName
        $response.windowTitle = ($script:target.MainWindowTitle -replace '\\r|\\n', ' ')
        $response.resolvedAtLocal = Get-BandCueNow
      }
    }
    elseif ($request.cmd -eq 'focus') {
      # Only ever requested when the cue is claimed system-wide, so taking the
      # foreground here cannot cost anyone the cue.
      if ($null -eq $script:target -or $script:target.HasExited) {
        $script:target = Resolve-BandCueTarget
      }
      if ($null -eq $script:target) {
        $response.error = 'no-musescore-window'
      }
      elseif (-not (Enable-BandCueTarget $script:target $request.retries $request.delayMs)) {
        $response.error = 'activation-failed'
      }
      else {
        $response.ok = $true
        $response.processId = $script:target.Id
        $response.windowTitle = ($script:target.MainWindowTitle -replace '\\r|\\n', ' ')
      }
    }
    elseif ($request.cmd -eq 'fire') {
      # A score closed or reopened since the last resolve leaves a stale handle;
      # re-resolve rather than firing a key into nothing.
      if ($null -eq $script:target -or $script:target.HasExited) {
        $script:target = Resolve-BandCueTarget
      }
      if ($null -eq $script:target) {
        $response.error = 'no-musescore-window'
      }
      else {
        # Posting needs no foreground window; SendKeys does, and activation is
        # not something a background process can count on being allowed.
        $posting = [bool]$request.post
        if (-not $posting -and -not (Enable-BandCueTarget $script:target $request.retries $request.delayMs)) {
          $response.error = 'activation-failed'
        }
        else {
          $response.delivery = if ($posting) { 'post' } else { 'sendkeys' }
          $hwnd = $script:target.MainWindowHandle
          # Prefix keys (stop, cursor to start of score) run here, inside the
          # lead time, so only the final key is left for the downbeat itself.
          if ($posting) {
            Post-BandCueKeys $hwnd $request.postKeys $request.gapMs
          } else {
            Send-BandCueKeys $request.keys $request.gapMs
          }
          $response.readyAtLocal = Get-BandCueNow
          $due = [int64]$request.dueLocalAt
          while ($true) {
            $remainingMs = $due - (Get-BandCueNow)
            if ($remainingMs -le 0) { break }
            if ($remainingMs -gt 25) {
              Start-Sleep -Milliseconds ($remainingMs - 15)
            } else {
              [System.Threading.Thread]::SpinWait(500)
            }
          }
          # Stamped before the send so it marks the downbeat itself, matching what
          # the one-shot path reports.
          $response.firedAtLocal = Get-BandCueNow
          if ($posting) {
            Post-BandCueKey $hwnd $request.postKey
          } else {
            [System.Windows.Forms.SendKeys]::SendWait($request.key)
          }
          $response.ok = $true
          $response.processId = $script:target.Id
          $response.processName = $script:target.ProcessName
          $response.windowTitle = ($script:target.MainWindowTitle -replace '\\r|\\n', ' ')
        }
      }
    }
    elseif ($request.cmd -eq 'keys') {
      if ($null -eq $script:target -or $script:target.HasExited) {
        $script:target = Resolve-BandCueTarget
      }
      if ($null -eq $script:target) {
        $response.error = 'no-musescore-window'
      }
      else {
        $posting = [bool]$request.post
        if (-not $posting -and -not (Enable-BandCueTarget $script:target $request.retries $request.delayMs)) {
          $response.error = 'activation-failed'
        }
        else {
          $response.delivery = if ($posting) { 'post' } else { 'sendkeys' }
          if ($posting) {
            Post-BandCueKeys $script:target.MainWindowHandle $request.postKeys $request.gapMs
          } else {
            Send-BandCueKeys $request.keys $request.gapMs
          }
          $response.ok = $true
          $response.processId = $script:target.Id
          $response.processName = $script:target.ProcessName
          $response.windowTitle = ($script:target.MainWindowTitle -replace '\\r|\\n', ' ')
        }
      }
    }
    else {
      $response.error = 'unknown-command'
    }
  } catch {
    $response.error = $_.Exception.Message
  }
  Write-BandCueResponse $response
}
[void][BandCueWin32]::timeEndPeriod(1)
`.trim();
}

interface PendingRequest {
  resolve: (response: TriggerResponse) => void;
  timer: NodeJS.Timeout;
}

/**
 * Node-side handle for the resident PowerShell. Requests are correlated by id;
 * a crash or a hung request resolves as a failure so the caller can fall back to
 * the one-shot path instead of missing the downbeat entirely.
 */
export class MuseScoreTrigger {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private startFailureDetail = "";

  constructor(
    private readonly config: MuseScoreTriggerConfig,
    private readonly onExit?: (detail: string) => void,
    // Tests substitute the PowerShell launch; production always uses the default.
    private readonly launch: (script: string) => ChildProcessWithoutNullStreams = (script) =>
      spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true }),
    // Escape hatch for a MuseScore build that ignores posted messages: fall back
    // to typing keys into the foreground window, as earlier versions did.
    private readonly allowPosting = true
  ) {}

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  get lastFailureDetail(): string {
    return this.startFailureDetail;
  }

  /** Starts the resident process if it isn't already up. Safe to call often. */
  start(): boolean {
    if (this.running) {
      return true;
    }

    try {
      const child = this.launch(buildTriggerScript(this.config));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.startFailureDetail = chunk.trim().slice(0, 220);
      });
      child.on("error", (error) => this.handleExit(error.message));
      child.on("exit", (code, signal) =>
        this.handleExit(`trigger process exited (code ${code ?? "null"}, signal ${signal ?? "none"})`)
      );
      this.child = child;
      return true;
    } catch (error) {
      this.startFailureDetail = error instanceof Error ? error.message : String(error);
      this.child = undefined;
      return false;
    }
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.stdin.end();
      child.kill();
    }
  }

  /**
   * Looks up the MuseScore window and caches it, without changing the foreground
   * window. Cheap enough to run whenever the room arms, so the scan is off the
   * count-in's critical path and a missing window is noticed before the cue.
   */
  async resolve(timeoutMs = 8000): Promise<TriggerResolveResult> {
    return this.request({ cmd: "resolve" }, timeoutMs);
  }

  /**
   * Brings MuseScore to the foreground and leaves it there, so the downbeat has
   * nothing left to do but send keys. Only safe once the cue is claimed
   * system-wide -- otherwise this takes the cue away from the host page.
   */
  async focus(timeoutMs = 8000): Promise<TriggerResolveResult> {
    return this.request({
      cmd: "focus",
      retries: this.config.activationRetries,
      delayMs: this.config.activationDelayMs
    }, timeoutMs);
  }

  /**
   * Takes the MuseScore window, sends the prefix keys, waits out the rest of the
   * count-in inside the trigger, and sends the final key on the downbeat.
   */
  async fire(
    prefixKeys: string[],
    key: string,
    dueLocalAt: number,
    timeoutMs?: number,
    // Some sequences are postable but must not be posted: text typed into a
    // MuseScore dialog (the measure number for Find / Go to) only reaches the
    // dialog through real keyboard focus. Posted to the main window it lands in
    // the score view instead, where digits are note durations -- it edits the
    // score. Such a sequence takes the foreground path or fails loudly.
    allowPost = true
  ): Promise<TriggerFireResult> {
    const wait = Math.max(0, dueLocalAt - Date.now());
    // Posting is preferred and needs no foreground window, but only when every
    // key in the sequence can be expressed that way -- a half-posted sequence
    // would leave the score in a state nobody asked for.
    const postable = this.allowPosting && allowPost
      ? parseSendKeysTokens([...prefixKeys, key])
      : undefined;
    return this.request({
      cmd: "fire",
      keys: prefixKeys,
      key,
      post: Boolean(postable),
      postKeys: postable?.slice(0, -1) ?? [],
      postKey: postable?.at(-1),
      dueLocalAt: Math.round(dueLocalAt),
      retries: this.config.activationRetries,
      delayMs: this.config.activationDelayMs,
      gapMs: this.config.commandGapMs
    }, timeoutMs ?? wait + 8000);
  }

  /** Sends keys immediately (Stop, and any play with no lead time left). */
  async sendKeys(keys: string[], timeoutMs = 8000, allowPost = true): Promise<TriggerFireResult> {
    const postable = this.allowPosting && allowPost ? parseSendKeysTokens(keys) : undefined;
    return this.request({
      cmd: "keys",
      keys,
      post: Boolean(postable),
      postKeys: postable ?? [],
      retries: this.config.activationRetries,
      delayMs: this.config.activationDelayMs,
      gapMs: this.config.commandGapMs
    }, timeoutMs);
  }

  private request(payload: Record<string, unknown>, timeoutMs: number): Promise<TriggerResponse> {
    if (!this.start()) {
      return Promise.resolve({ ok: false, error: this.startFailureDetail || "trigger-unavailable" });
    }

    const child = this.child;
    if (!child) {
      return Promise.resolve({ ok: false, error: "trigger-unavailable" });
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<TriggerResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A trigger that stopped answering is not trustworthy for the next
        // downbeat either; drop it so the next command starts a fresh one.
        this.stop();
        resolve({ ok: false, error: "trigger-timeout" });
      }, timeoutMs);

      this.pending.set(id, { resolve, timer });

      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (error) {
        this.settle(id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleResponseLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleResponseLine(line: string): void {
    let parsed: TriggerResponse | undefined;
    try {
      parsed = JSON.parse(line) as TriggerResponse;
    } catch {
      return;
    }

    if (typeof parsed.id !== "number") {
      return;
    }
    this.settle(parsed.id, parsed);
  }

  private settle(id: number, response: TriggerResponse): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(response);
  }

  private handleExit(detail: string): void {
    this.startFailureDetail = detail;
    this.child = undefined;
    this.stdoutBuffer = "";
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: detail });
    }
    this.onExit?.(detail);
  }
}
