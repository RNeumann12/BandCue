import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  POSITION_UNITS_PER_SVG_UNIT,
  ScoreExportQueue,
  buildExportJob,
  buildScoreTiming,
  exportFiles,
  parsePositionsXml,
  parseScorePartsOutput,
  parseSvgPageSize,
  readCachedExport,
  scoreIdFor,
  type ExportedScore,
  type ScoreExportSource
} from "./musescore-score-export.js";
import type { ScoreManifest, ScoreTiming } from "../shared/protocol.js";

// examples/score-view/timing-example.mscz: a pickup, a repeat of measures 2-3
// (indices), D.S. al Coda from measure 7 back to the segno at 4, To Coda at 5,
// and a tempo change from 120 to 60 BPM at measure 6. score.mpos/score.spos are
// MuseScore 4.7.5's own exports of it.
const EXAMPLES = join(import.meta.dirname, "../../examples/score-view");
const mpos = parsePositionsXml(readFileSync(join(EXAMPLES, "score.mpos"), "utf8"));
const spos = parsePositionsXml(readFileSync(join(EXAMPLES, "score.spos"), "utf8"));
const A4 = { width: 9924, height: 14028 };

describe("MuseScore position exports", () => {
  it("parses measure positions in playback order, repeats and jumps resolved", () => {
    expect(mpos.elements.size).toBe(10);
    expect(mpos.events.map((event) => event.elid)).toEqual([0, 1, 2, 3, 2, 3, 4, 5, 6, 7, 4, 5, 8, 9]);
    // Pickup: one beat at 120 BPM. Measure 6 onwards: 60 BPM, four seconds a bar.
    expect(mpos.events.slice(0, 3).map((event) => event.position)).toEqual([0, 500, 2500]);
    expect(mpos.events[9]!.position - mpos.events[8]!.position).toBe(4000);
  });

  it("uses coordinates twelve times the SVG's", () => {
    // The first measure starts where score-1.svg draws the staff lines:
    // points="1315.34,2114.17 9215.34,2114.17".
    const first = mpos.elements.get(0)!;
    expect(first.x / POSITION_UNITS_PER_SVG_UNIT).toBeCloseTo(1315.34, 1);
    expect(first.y / POSITION_UNITS_PER_SVG_UNIT).toBeCloseTo(2114.17, 1);
  });

  it("reads page sizes from the SVG viewBox", () => {
    const svg = readFileSync(join(EXAMPLES, "export/score-1.svg"), "utf8");
    expect(parseSvgPageSize(svg)).toEqual(A4);
    expect(parseSvgPageSize("<svg width=\"1\">")).toBeUndefined();
  });
});

describe("buildScoreTiming", () => {
  const timing = buildScoreTiming(mpos, spos, [A4]);

  it("lists every pass with its start and end, ending where the next begins", () => {
    expect(timing.events.map((event) => event.m)).toEqual([0, 1, 2, 3, 2, 3, 4, 5, 6, 7, 4, 5, 8, 9]);
    for (let index = 1; index < timing.events.length; index += 1) {
      expect(timing.events[index]!.t).toBe(timing.events[index - 1]!.e);
    }
    expect(timing.durationMs).toBe(timing.events.at(-1)!.e);
    expect(timing.measures).toHaveLength(10);
  });

  it("puts a cursor anchor on every note onset, at the note's time", () => {
    // Measure 1 at 120 BPM: four quarter notes, 500 ms apart.
    const measure1 = timing.events[1]!;
    expect(measure1.b.map(([time]) => time)).toEqual([500, 1000, 1500, 2000, 2500]);
    for (const event of timing.events) {
      const times = event.b.map(([time]) => time);
      expect(times[0]).toBe(event.t);
      expect(times.at(-1)).toBe(event.e);
      expect([...times].sort((left, right) => left - right)).toEqual(times);
      const box = timing.measures[event.m]!;
      for (const [, x] of event.b.slice(0, -1)) {
        expect(x).toBeGreaterThanOrEqual(box.x);
        expect(x).toBeLessThanOrEqual(box.x + box.w);
      }
    }
  });

  it("flows into the next measure on the same line, and runs to the bar line before a jump", () => {
    const firstPassOf3 = timing.events[3]!;
    const secondPassOf3 = timing.events[5]!;
    const box3 = timing.measures[3]!;
    // Before the repeat jumps back to 2, the cursor ends on 3's bar line ...
    expect(firstPassOf3.b.at(-1)![1]).toBeCloseTo(box3.x + box3.w, 1);
    // ... and the second time through it flows on to 4's first note.
    expect(secondPassOf3.b.at(-1)![1]).toBe(timing.events[6]!.b[0]![1]);
  });

  it("estimates the last measure from the one before it", () => {
    const last = timing.events.at(-1)!;
    expect(last.e - last.t).toBe(4000);
  });
});

describe("export job and parts", () => {
  it("exports the full score and every part as SVG, mpos and spos", () => {
    expect(buildExportJob(2)).toEqual([
      { in: "score.mscz", out: ["score.svg", "score.mpos", "score.spos"] },
      { in: "part-1.mscz", out: ["part-1.svg", "part-1.mpos", "part-1.spos"] },
      { in: "part-2.mscz", out: ["part-2.svg", "part-2.mpos", "part-2.spos"] }
    ]);
  });

  it("parses --score-parts output and tolerates log lines around it", () => {
    const payload = JSON.stringify({
      parts: ["E-Gitarre", "Schlagzeug"],
      partsBin: [Buffer.from("one").toString("base64"), Buffer.from("two").toString("base64")]
    });
    const parts = parseScorePartsOutput(`some log\n${payload}\n`);
    expect(parts.map((part) => part.name)).toEqual(["E-Gitarre", "Schlagzeug"]);
    expect(parts[1]!.mscz.toString()).toBe("two");
    expect(parseScorePartsOutput("garbage")).toEqual([]);
  });

  it("derives the score id from the contents and the exporter version", () => {
    const id = scoreIdFor(Buffer.from("score"));
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(scoreIdFor(Buffer.from("score"))).toBe(id);
    expect(scoreIdFor(Buffer.from("score!"))).not.toBe(id);
  });

  it("finds a cached export and lists its files manifest last", async () => {
    const manifest = JSON.parse(readFileSync(join(EXAMPLES, "export/manifest.json"), "utf8")) as ScoreManifest;
    const cached = await readCachedExport(join(EXAMPLES, ".."), "score-view/export");
    expect(cached).toBeUndefined();
    expect(exportFiles(manifest).at(-1)).toBe("manifest.json");
    expect(exportFiles(manifest)).toContain("part-2-1.svg");
  });

  it("keeps the committed example export in step with the parser", () => {
    const committed = JSON.parse(readFileSync(join(EXAMPLES, "export/score.timing.json"), "utf8")) as ScoreTiming;
    expect(committed.events.map((event) => event.m)).toEqual(buildScoreTiming(mpos, spos, [A4]).events.map((event) => event.m));
  });
});

describe("ScoreExportQueue", () => {
  function setup(options: { paused?: () => boolean; fail?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bandcue-queue-"));
    const sources: Record<string, ScoreExportSource> = {};
    for (const name of ["A", "B"]) {
      const absolutePath = join(dir, `${name}.mscz`);
      writeFileSync(absolutePath, name);
      sources[name] = { absolutePath, relativePath: `${name}.mscz`, title: name };
    }
    const exported: string[] = [];
    const published: string[] = [];
    let time = 1_000;
    const queue = new ScoreExportQueue({
      exportScore: async (source) => {
        if (options.fail) {
          throw new Error("MuseScore crashed");
        }
        exported.push(source.relativePath);
        const scoreId = scoreIdFor(readFileSync(source.absolutePath));
        return { scoreId, dir, files: ["manifest.json"], manifest: { parts: [] } as unknown as ScoreManifest } satisfies ExportedScore;
      },
      publish: async (result) => {
        published.push(result.scoreId);
      },
      isPaused: options.paused,
      now: () => time
    });
    return { queue, sources, exported, published, advance: (ms: number) => { time += ms; } };
  }

  it("exports the current song first, then the rest of the setlist", async () => {
    const { queue, sources, exported } = setup();
    queue.sync([{ songId: "a", source: sources.A! }, { songId: "b", source: sources.B! }], "B.mscz");
    await vi.waitFor(() => expect(exported).toEqual(["B.mscz", "A.mscz"]));
    await vi.waitFor(() => expect(queue.reports().every((report) => report.status === "ready")).toBe(true));
    expect(queue.reports().map((report) => report.songId)).toEqual(["a", "b"]);
    expect(queue.reports()[0]!.scoreId).toMatch(/^[a-f0-9]{32}$/);
  });

  it("waits while paused", async () => {
    let paused = true;
    const { queue, sources, exported } = setup({ paused: () => paused });
    queue.sync([{ songId: "a", source: sources.A! }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exported).toEqual([]);
    expect(queue.reports()[0]!.status).toBe("queued");
    paused = false;
    queue.resume();
    await vi.waitFor(() => expect(exported).toEqual(["A.mscz"]));
  });

  it("exports a score again once its file changes", async () => {
    const { queue, sources, exported } = setup();
    queue.sync([{ songId: "a", source: sources.A! }]);
    await vi.waitFor(() => expect(queue.reports()[0]!.status).toBe("ready"));
    const firstId = queue.reports()[0]!.scoreId;
    writeFileSync(sources.A!.absolutePath, "A, second take");
    queue.sync([{ songId: "a", source: sources.A! }]);
    await vi.waitFor(() => expect(exported).toEqual(["A.mscz", "A.mscz"]));
    await vi.waitFor(() => expect(queue.reports()[0]!.scoreId).not.toBe(firstId));
  });

  it("re-confirms a published export with the coordinator after a reconnect", async () => {
    const { queue, sources, exported, published } = setup();
    queue.sync([{ songId: "a", source: sources.A! }]);
    await vi.waitFor(() => expect(published).toHaveLength(1));
    queue.invalidatePublished();
    await vi.waitFor(() => expect(published).toHaveLength(2));
    expect(exported).toHaveLength(1);
  });

  it("reports a failed export and retries it later", async () => {
    const { queue, sources } = setup({ fail: true });
    queue.sync([{ songId: "a", source: sources.A! }]);
    await vi.waitFor(() => expect(queue.reports()[0]).toMatchObject({ status: "failed", detail: "MuseScore crashed" }));
    expect(queue.reports()[0]!.scoreId).toBeUndefined();
  });
});
