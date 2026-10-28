import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScoreExportReport } from "../shared/protocol.js";
import type { MuseScoreRunner } from "./musescore-score-export.js";

// Turns the Guitar Pro files imported from Songsterr into MuseScore scores, so
// the score-view export queue can treat them like any local score. The helper's
// own cache holds the converted files -- never the band's score folders, whose
// hand-edited scores an import must not touch. Conversion is MuseScore's own
// Guitar Pro import (`MuseScore4.exe -o x.mscz in.gp`).

export interface WantedImport {
  songId: string;
  key: string;
  importId: string;
}

interface TrackedImport {
  state: "queued" | "exporting" | "failed";
  detail?: string;
  failedAt?: number;
}

export interface ScoreImportConverterOptions {
  cacheDir: string;
  /** Fetches `/api/scores/<importId>/source.gp` from the coordinator. */
  download: (importId: string) => Promise<Buffer>;
  /** Converts a Guitar Pro file to a MuseScore score. */
  convert: (gpPath: string, msczPath: string) => Promise<void>;
  isPaused?: () => boolean;
  onChange?: () => void;
  now?: () => number;
  log?: (message: string) => void;
  retryMs?: number;
}

export class ScoreImportConverter {
  private wanted: WantedImport[] = [];
  private readonly tracked = new Map<string, TrackedImport>();
  private running = false;

  constructor(private readonly options: ScoreImportConverterOptions) {}

  /** The converted score of an import, once there is one. */
  scorePathFor(importId: string): string | undefined {
    const path = join(this.options.cacheDir, `${importId}.mscz`);
    return existsSync(path) ? path : undefined;
  }

  /** Replaces the wanted imports and converts the ones without a score yet. */
  sync(wanted: WantedImport[]): void {
    this.wanted = wanted;
    void this.pump();
  }

  /** Imports still on their way to a score (converted ones report through the export queue). */
  reports(): ScoreExportReport[] {
    return this.wanted
      .filter((entry) => !this.scorePathFor(entry.importId))
      .map((entry) => {
        const item = this.tracked.get(entry.importId);
        return {
          songId: entry.songId,
          relativePath: `songsterr/${entry.key}.gp`,
          status: item?.state ?? "queued",
          detail: item?.detail,
          importKey: entry.key,
          importId: entry.importId
        };
      });
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (;;) {
        if (this.options.isPaused?.()) {
          return;
        }
        const next = this.nextImport();
        if (!next) {
          return;
        }
        await this.convert(next);
      }
    } catch (error) {
      this.options.log?.(`Songsterr import queue stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private nextImport(): string | undefined {
    const now = (this.options.now ?? Date.now)();
    const retryMs = this.options.retryMs ?? 120_000;
    for (const { importId } of this.wanted) {
      if (this.scorePathFor(importId)) {
        continue;
      }
      const item = this.tracked.get(importId);
      if (!item || item.state === "queued" || (item.state === "failed" && now - (item.failedAt ?? 0) > retryMs)) {
        return importId;
      }
    }
    return undefined;
  }

  private async convert(importId: string): Promise<void> {
    const item: TrackedImport = { state: "exporting" };
    this.tracked.set(importId, item);
    this.options.onChange?.();
    const gpPath = join(this.options.cacheDir, `${importId}.gp`);
    const partial = join(this.options.cacheDir, `${importId}.partial.mscz`);
    try {
      await mkdir(this.options.cacheDir, { recursive: true });
      await writeFile(gpPath, await this.options.download(importId));
      await this.options.convert(gpPath, partial);
      // Only a finished score gets the name the export queue looks for.
      await rename(partial, join(this.options.cacheDir, `${importId}.mscz`));
      this.tracked.delete(importId);
      this.options.log?.(`Converted Songsterr import ${importId}.`);
    } catch (error) {
      item.state = "failed";
      item.failedAt = (this.options.now ?? Date.now)();
      item.detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 300);
      this.options.log?.(`Converting Songsterr import ${importId} failed: ${item.detail}`);
      await rm(partial, { force: true });
    } finally {
      await rm(gpPath, { force: true });
    }
    this.options.onChange?.();
  }
}

/** `MuseScore4.exe -o <mscz> <gp>`, failing unless MuseScore wrote the score. */
export async function convertGuitarPro(
  run: MuseScoreRunner,
  executable: string,
  gpPath: string,
  msczPath: string,
  cwd: string
): Promise<void> {
  const result = await run(executable, ["-o", msczPath, gpPath], { cwd, timeoutMs: 120_000 });
  if (result.code !== 0 || !existsSync(msczPath)) {
    const reason = (result.stderr || result.stdout).trim().split(/\r?\n/).pop()?.slice(0, 200);
    throw new Error(`MuseScore could not import the Guitar Pro file (exit ${result.code})${reason ? `: ${reason}` : ""}.`);
  }
}
