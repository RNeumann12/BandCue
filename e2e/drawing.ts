import type { Page } from "@playwright/test";

/**
 * Waits until the page draws frames steadily again.
 *
 * The score view writes the count-in, the bar and its mode on animation
 * frames. Headless WebKit on a cold CI runner can go 0.6-1.7 s without a
 * frame while it paints a freshly opened score for the first time (its main
 * thread stays free; only frames stop), and a 1.5 s count-in started then can
 * be over before the next one. A band never presses Play that soon after a
 * tablet opened the notes; a test does, so it waits for the page to be drawing
 * before it starts a count-in.
 */
export async function untilDrawing(page: Page, { frames = 5, maxGapMs = 400, timeoutMs = 15_000 } = {}) {
  const steady = await page.evaluate(async ({ frames, maxGapMs, timeoutMs }) => {
    const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const giveUpAt = performance.now() + timeoutMs;
    let last = await nextFrame();
    let run = 0;
    while (run < frames) {
      const now = await nextFrame();
      run = now - last <= maxGapMs ? run + 1 : 0;
      last = now;
      if (now > giveUpAt) {
        return false;
      }
    }
    return true;
  }, { frames, maxGapMs, timeoutMs });
  if (!steady) {
    throw new Error(`The page did not draw ${frames} frames in a row within ${maxGapMs} ms of each other in ${timeoutMs} ms.`);
  }
}
