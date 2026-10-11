import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

/**
 * Songsterr's Plus speed panel needs a Plus account, so it cannot be opened in
 * CI. This is a replica of its structure as shipped in Songsterr's own bundle
 * (October 2026), on a German UI, driven by the real content script in a real
 * browser:
 *
 *   div[role=dialog][data-tab-control=speed]
 *     close button (localized aria-label, class "<hash>_close <hash>_popupCloseButton")
 *     presets 15% 25% 50% 75% 100% 125% 150% 175% and a "- | +" toggle whose
 *       aria-label is localized ("Feineinstellung") -- the presets disappear
 *       once fine tuning is shown
 *     fine tuning: a range input in *BPM*, -1% / "N%" / +1%, then a
 *       "Back to presets" button in the same section
 *
 * Every trap here broke real tempos: matching the toggle by its English label
 * failed on a German UI, the BPM slider must never get a percentage, and
 * taking the section's last button for "+" clicked "Back to presets" instead
 * (found on a real iPad). The slow variant renders each update late, like an iPad.
 */
const SPEED_PANEL_REPLICA = `<!doctype html><html lang="de"><body>
<button id="control-speed"><div><span>100%</span></div></button>
<script>
const SONG_BPM = 120;
const presets = [15, 25, 50, 75, 100, 125, 150, 175];
let speed = 100, fine = false, panel;
const renderDelayMs = window.SLOW_RENDER ? 120 : 0;
const speedButton = document.getElementById("control-speed");
function setSpeed(value) {
  speed = Math.max(15, Math.min(175, value));
  speedButton.querySelector("span").textContent = Math.round(speed) + "%";
  if (renderDelayMs) setTimeout(render, renderDelayMs); else render();
}
function button(label, text, onClick) {
  const element = document.createElement("button");
  if (label) element.setAttribute("aria-label", label);
  element.textContent = text;
  element.onclick = onClick;
  return element;
}
function render() {
  if (!panel) return;
  panel.innerHTML = "";
  // Songsterr's close button: localized label, but always its "close" classes.
  const close = button("Schließen", "", () => { panel.remove(); panel = undefined; });
  close.className = "BHH_eW_close Y74j0G_popupCloseButton";
  panel.append(close);
  const section = document.createElement("section");
  if (!fine) {
    for (const preset of presets) section.append(button("", preset + "%", () => setSpeed(preset)));
    section.append(button("Feineinstellung", "- | +", () => {
      fine = true;
      if (renderDelayMs) setTimeout(render, renderDelayMs); else render();
    }));
  } else {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(Math.ceil(SONG_BPM * 15 / 100));
    slider.max = String(Math.floor(SONG_BPM * 175 / 100));
    slider.value = String(Math.round(SONG_BPM * speed / 100));
    slider.oninput = () => setSpeed(+(Number(slider.value) * 100 / SONG_BPM).toFixed(2));
    const value = document.createElement("div");
    value.innerHTML = "<span>" + Math.round(speed) + "%</span>";
    section.append(
      slider,
      button("Geschwindigkeit verringern", "", () => setSpeed(speed - 1)),
      value,
      button("Geschwindigkeit erhöhen", "", () => setSpeed(speed + 1)),
      button("", "Zurück zu den Presets", () => { fine = false; render(); })
    );
  }
  panel.append(section);
}
speedButton.onclick = () => {
  if (panel) { panel.remove(); panel = undefined; return; }
  fine = false;
  panel = document.createElement("div");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("data-tab-control", "speed");
  document.body.append(panel);
  render();
};
</script></body></html>`;

test.describe("Songsterr Plus speed panel", () => {
  async function load(page: import("@playwright/test").Page, slow: boolean) {
    const contentScript = await readFile("extension/songsterr/content-script.js", "utf8");
    await page.setContent(SPEED_PANEL_REPLICA.replace("window.SLOW_RENDER", String(slow)));
    expect(await page.evaluate("renderDelayMs")).toBe(slow ? 120 : 0);
    await page.evaluate(() => {
      const listeners: Array<(message: unknown, sender: unknown, respond: (r: unknown) => void) => unknown> = [];
      const runtime = {
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
      };
      Object.assign(window, {
        chrome: { runtime },
        bandcueTempo: (tempoPercent: number) =>
          new Promise((resolve) => listeners[0]({ type: "bandcueSetTempo", tempoPercent }, {}, resolve))
      });
    });
    await page.addScriptTag({ content: contentScript });
  }

  async function applyTempo(page: import("@playwright/test").Page, percent: number) {
    const result = await page.evaluate(
      (tempoPercent) => (window as unknown as { bandcueTempo: (p: number) => Promise<{ ok: boolean; detail: string }> })
        .bandcueTempo(tempoPercent),
      percent
    );
    expect(result.ok, result.detail).toBe(true);
    await expect(page.locator("#control-speed")).toHaveText(`${percent}%`);
    await expect(page.locator("[data-tab-control='speed']")).toHaveCount(0);
  }

  for (const slow of [false, true]) {
    const render = slow ? "rendering late like an iPad" : "rendering at once";
    for (const percent of [92, 125, 67, 100]) {
      test(`applies ${percent}% on a German UI and closes the panel again (${render})`, async ({ page }) => {
        await load(page, slow);
        await applyTempo(page, percent);
      });
    }

    test(`steps up and down through fine tuning, never into "Back to presets" (${render})`, async ({ page }) => {
      await load(page, slow);
      for (const percent of [92, 95, 88, 103]) {
        await applyTempo(page, percent);
      }
    });
  }
});
