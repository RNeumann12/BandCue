import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  MuseScoreTrigger,
  buildTriggerScript,
  parseSendKeysToken,
  parseSendKeysTokens
} from "./musescore-trigger.js";

const config = {
  processMatch: "MuseScore|mscore",
  activationRetries: 5,
  activationDelayMs: 90,
  commandGapMs: 120
};

/** Stands in for the resident PowerShell: records what it was told, replies on demand. */
function createFakeProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & {
    written: string[];
  };
  const written: string[] = [];
  Object.assign(child, {
    stdout: Object.assign(stdout, { setEncoding: () => stdout }),
    stderr: Object.assign(stderr, { setEncoding: () => stderr }),
    stdin: { write: (line: string) => written.push(line), end: () => undefined },
    kill: () => undefined,
    exitCode: null,
    killed: false,
    written
  });

  return {
    child,
    written,
    requests: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
    reply: (response: Record<string, unknown>) => stdout.emit("data", `${JSON.stringify(response)}\n`),
    emitRaw: (chunk: string) => stdout.emit("data", chunk),
    exit: (code: number | null) => child.emit("exit", code, null)
  };
}

describe("buildTriggerScript", () => {
  it("loads the SendKeys assemblies once, outside the request loop", () => {
    const script = buildTriggerScript(config);
    const preambleAt = script.indexOf("Add-Type -AssemblyName System.Windows.Forms");
    const loopAt = script.indexOf("while ($true)");

    expect(preambleAt).toBeGreaterThanOrEqual(0);
    expect(loopAt).toBeGreaterThan(preambleAt);
    // The whole point of the resident process: the expensive load happens before
    // any request is read, so no count-in ever pays for it.
    expect(script.slice(loopAt)).not.toContain("Add-Type");
  });

  it("escapes single quotes in the process match so a quote cannot break the script", () => {
    const script = buildTriggerScript({ ...config, processMatch: "Muse'Score" });
    expect(script).toContain("$script:processMatch = 'Muse''Score'");
  });

  it("never takes the foreground during resolve", () => {
    const script = buildTriggerScript(config);
    const resolveBranch = script.slice(
      script.indexOf("elseif ($request.cmd -eq 'resolve')"),
      script.indexOf("elseif ($request.cmd -eq 'focus')")
    );

    expect(resolveBranch).toContain("Resolve-BandCueTarget");
    // Arming must not pull focus off the page the Helix cue is typed into unless
    // the cue has been claimed system-wide -- otherwise the keystroke lands in
    // MuseScore and no Play is ever requested. That case uses `focus` instead.
    expect(resolveBranch).not.toContain("Enable-BandCueTarget");
    expect(resolveBranch).not.toContain("SendKeys");
  });

  it("offers a separate focus command for when the cue is claimed system-wide", () => {
    const script = buildTriggerScript(config);
    const focusBranch = script.slice(
      script.indexOf("elseif ($request.cmd -eq 'focus')"),
      script.indexOf("elseif ($request.cmd -eq 'fire')")
    );

    expect(focusBranch).toContain("Enable-BandCueTarget");
    // Focus readies the window; it must not touch the score.
    expect(focusBranch).not.toContain("SendKeys");
  });

  it("sends the prefix keys inside the lead time, leaving only one key for the downbeat", () => {
    const script = buildTriggerScript(config);
    const prefixAt = script.indexOf("Send-BandCueKeys $request.keys $request.gapMs");
    const waitAt = script.indexOf("$due = [int64]$request.dueLocalAt");
    const finalKeyAt = script.indexOf("SendKeys]::SendWait($request.key)");

    expect(prefixAt).toBeGreaterThanOrEqual(0);
    expect(waitAt).toBeGreaterThan(prefixAt);
    expect(finalKeyAt).toBeGreaterThan(waitAt);
  });

  it("stamps the fire time before sending the key, so it marks the downbeat", () => {
    const script = buildTriggerScript(config);
    const stampAt = script.indexOf("$response.firedAtLocal = Get-BandCueNow");
    const sendAt = script.indexOf("SendKeys]::SendWait($request.key)");
    expect(stampAt).toBeGreaterThanOrEqual(0);
    expect(sendAt).toBeGreaterThan(stampAt);
  });
});

describe("parseSendKeysToken", () => {
  it("converts the keys BandCue actually sends MuseScore", () => {
    // VK_SPACE, VK_ESCAPE, VK_HOME.
    expect(parseSendKeysToken(" ")).toMatchObject({ virtualKey: 0x20, ctrl: false });
    expect(parseSendKeysToken("{ESC}")).toMatchObject({ virtualKey: 0x1b });
    expect(parseSendKeysToken("^{HOME}")).toMatchObject({ virtualKey: 0x24, ctrl: true });
  });

  it("marks the navigation cluster as extended, so Ctrl+Home is not read as keypad Home", () => {
    expect(parseSendKeysToken("^{HOME}")).toMatchObject({ extended: true });
    expect(parseSendKeysToken("{END}")).toMatchObject({ extended: true });
    expect(parseSendKeysToken("{LEFT}")).toMatchObject({ extended: true });
    // Space and Escape are not extended keys.
    expect(parseSendKeysToken(" ")).toMatchObject({ extended: false });
    expect(parseSendKeysToken("{ESC}")).toMatchObject({ extended: false });
  });

  it("parses Shift+Space, MuseScore's play-from-selection", () => {
    // The default reset-before-play key. Written "+ " in SendKeys form, which is
    // easy to mistake for a stray space.
    expect(parseSendKeysToken("+ ")).toMatchObject({
      virtualKey: 0x20,
      shift: true,
      ctrl: false,
      extended: false
    });
  });

  it("handles combined modifier prefixes", () => {
    expect(parseSendKeysToken("^%+{END}")).toMatchObject({
      virtualKey: 0x23,
      ctrl: true,
      alt: true,
      shift: true
    });
  });

  it("returns undefined for tokens it cannot express", () => {
    // Literal text and SendKeys repeat groups have no single-keystroke meaning.
    expect(parseSendKeysToken("{F25}")).toBeUndefined();
    expect(parseSendKeysToken("hello")).toBeUndefined();
    expect(parseSendKeysToken("{}")).toBeUndefined();
  });

  it("refuses a whole sequence when any key is unpostable", () => {
    // A partly-posted sequence would leave the score in a state nobody asked for,
    // so the caller keeps SendKeys for all of it instead.
    expect(parseSendKeysTokens(["{ESC}", "^{HOME}", " "])).toHaveLength(3);
    expect(parseSendKeysTokens(["{ESC}", "no-such-key", " "])).toBeUndefined();
  });
});

describe("MuseScoreTrigger", () => {
  it("passes the downbeat to the process rather than waiting in Node", async () => {
    const fake = createFakeProcess();
    const trigger = new MuseScoreTrigger(config, undefined, () => fake.child);

    const dueLocalAt = Date.now() + 5000;
    const pending = trigger.fire(["{ESC}", "^{HOME}"], " ", dueLocalAt);
    const request = fake.requests()[0];
    expect(request).toMatchObject({ cmd: "fire", key: " ", dueLocalAt: Math.round(dueLocalAt) });
    // Posted rather than typed, so no foreground window is required.
    expect(request).toMatchObject({ post: true });
    expect(request.postKey).toMatchObject({ virtualKey: 0x20 });
    expect(request.postKeys).toHaveLength(2);

    fake.reply({ id: request.id, ok: true, firedAtLocal: dueLocalAt, readyAtLocal: dueLocalAt - 200 });
    await expect(pending).resolves.toMatchObject({ ok: true, firedAtLocal: dueLocalAt });
  });

  it("matches replies to their request when answers arrive out of order", async () => {
    const fake = createFakeProcess();
    const trigger = new MuseScoreTrigger(config, undefined, () => fake.child);

    const first = trigger.resolve();
    const second = trigger.sendKeys(["{ESC}"]);
    const [firstRequest, secondRequest] = fake.requests();

    fake.reply({ id: secondRequest.id, ok: true, windowTitle: "second" });
    fake.reply({ id: firstRequest.id, ok: true, windowTitle: "first" });

    await expect(second).resolves.toMatchObject({ windowTitle: "second" });
    await expect(first).resolves.toMatchObject({ windowTitle: "first" });
  });

  it("reassembles a reply split across chunks", async () => {
    const fake = createFakeProcess();
    const trigger = new MuseScoreTrigger(config, undefined, () => fake.child);

    const pending = trigger.resolve();
    const id = fake.requests()[0].id;
    fake.emitRaw(`{"id":${id},"ok":true,"window`);
    fake.emitRaw('Title":"Karma Police"}\n');

    await expect(pending).resolves.toMatchObject({ ok: true, windowTitle: "Karma Police" });
  });

  it("types a sequence the caller may not post, however postable it looks", async () => {
    const fake = createFakeProcess();
    const trigger = new MuseScoreTrigger(config, undefined, () => fake.child);

    // Find / Go to: every token is postable on its own, but posted into the main
    // window the digits are note durations and would edit the score.
    void trigger.fire(["{ESC}", "^{HOME}", "^f", "^a", "1", "6", "{ENTER}"], "+ ", Date.now() + 5000, undefined, false);
    expect(fake.requests()[0]).toMatchObject({ post: false, key: "+ " });
    expect(fake.requests()[0].postKeys).toEqual([]);

    void trigger.sendKeys(["{ESC}", "^f", "8", "{ENTER}"], undefined, false);
    expect(fake.requests()[1]).toMatchObject({ post: false });
  });

  it("falls back to typing keys when posting is disabled", async () => {
    const fake = createFakeProcess();
    const trigger = new MuseScoreTrigger(config, undefined, () => fake.child, false);

    void trigger.fire(["{ESC}"], " ", Date.now() + 5000);
    expect(fake.requests()[0]).toMatchObject({ post: false, keys: ["{ESC}"], key: " " });
  });

  it("does not post a sequence containing a key it cannot express", async () => {
    const fake = createFakeProcess();
    const trigger = new MuseScoreTrigger(config, undefined, () => fake.child);

    void trigger.fire(["{ESC}", "some literal text"], " ", Date.now() + 5000);
    expect(fake.requests()[0]).toMatchObject({ post: false });
  });

  it("fails an in-flight command when the process dies, so the caller can fall back", async () => {
    const onExit = vi.fn();
    const fake = createFakeProcess();
    const trigger = new MuseScoreTrigger(config, onExit, () => fake.child);

    const pending = trigger.fire([], " ", Date.now() + 5000);
    fake.exit(1);

    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(onExit).toHaveBeenCalledOnce();
    expect(trigger.running).toBe(false);
  });

  it("gives up on a trigger that stops answering instead of missing the downbeat silently", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProcess();
      const trigger = new MuseScoreTrigger(config, undefined, () => fake.child);

      const pending = trigger.resolve(500);
      await vi.advanceTimersByTimeAsync(600);

      await expect(pending).resolves.toMatchObject({ ok: false, error: "trigger-timeout" });
      // Dropped, so the next command starts a fresh process rather than queueing
      // behind whatever wedged this one.
      expect(trigger.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
