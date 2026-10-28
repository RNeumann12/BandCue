import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScoreImportConverter, convertGuitarPro } from "./songsterr-score-import.js";

const IMPORT_ID = "c".repeat(32);

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (check()) {
        resolve();
      } else if (Date.now() - started > 2000) {
        reject(new Error("timed out"));
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

describe("ScoreImportConverter", () => {
  it("downloads an import, converts it into its own cache, and then reports nothing", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bandcue-import-"));
    const converted: string[] = [];
    const converter = new ScoreImportConverter({
      cacheDir,
      download: async () => Buffer.from("gp bytes"),
      convert: async (gpPath, msczPath) => {
        converted.push(readFileSync(gpPath, "utf8"));
        writeFileSync(msczPath, "mscz");
      }
    });
    converter.sync([{ songId: "zombie", key: "s900", importId: IMPORT_ID }]);
    expect(converter.reports()).toEqual([expect.objectContaining({
      songId: "zombie", importKey: "s900", importId: IMPORT_ID, status: "exporting"
    })]);

    await waitFor(() => Boolean(converter.scorePathFor(IMPORT_ID)));
    expect(converted).toEqual(["gp bytes"]);
    expect(converter.scorePathFor(IMPORT_ID)).toBe(join(cacheDir, `${IMPORT_ID}.mscz`));
    expect(converter.reports()).toEqual([]);
  });

  it("reports a failed conversion and waits before trying again", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bandcue-import-"));
    let attempts = 0;
    let now = 1000;
    const converter = new ScoreImportConverter({
      cacheDir,
      download: async () => Buffer.from("gp"),
      convert: async () => {
        attempts += 1;
        throw new Error("MuseScore could not import it");
      },
      now: () => now,
      retryMs: 60_000
    });
    converter.sync([{ songId: "zombie", key: "s900", importId: IMPORT_ID }]);
    await waitFor(() => converter.reports()[0]?.status === "failed");
    expect(converter.reports()[0]?.detail).toBe("MuseScore could not import it");
    expect(converter.scorePathFor(IMPORT_ID)).toBeUndefined();

    converter.sync([{ songId: "zombie", key: "s900", importId: IMPORT_ID }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(1);
    now += 61_000;
    converter.sync([{ songId: "zombie", key: "s900", importId: IMPORT_ID }]);
    await waitFor(() => attempts === 2);
  });

  it("waits while paused", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bandcue-import-"));
    let paused = true;
    let downloads = 0;
    const converter = new ScoreImportConverter({
      cacheDir,
      download: async () => {
        downloads += 1;
        return Buffer.from("gp");
      },
      convert: async (_gpPath, msczPath) => writeFileSync(msczPath, "mscz"),
      isPaused: () => paused
    });
    converter.sync([{ songId: "zombie", key: "s900", importId: IMPORT_ID }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(downloads).toBe(0);
    expect(converter.reports()[0]?.status).toBe("queued");
    paused = false;
    converter.sync([{ songId: "zombie", key: "s900", importId: IMPORT_ID }]);
    await waitFor(() => Boolean(converter.scorePathFor(IMPORT_ID)));
  });
});

describe("convertGuitarPro", () => {
  it("runs MuseScore's converter and insists on a written score", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandcue-import-"));
    const out = join(dir, "x.mscz");
    const calls: string[][] = [];
    await convertGuitarPro(async (_exe, args) => {
      calls.push(args);
      writeFileSync(out, "mscz");
      return { code: 0, stdout: "", stderr: "" };
    }, "MuseScore4.exe", join(dir, "x.gp"), out, dir);
    expect(calls).toEqual([["-o", out, join(dir, "x.gp")]]);

    await expect(convertGuitarPro(async () => ({ code: 1, stdout: "", stderr: "bad file\nunsupported format" }),
      "MuseScore4.exe", join(dir, "y.gp"), join(dir, "y.mscz"), dir)).rejects.toThrow(/exit 1\): unsupported format/);
  });
});
