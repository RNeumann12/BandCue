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
  planVoices,
  readScoreInstruments,
  readScoreMarks,
  withoutMultimeasureRests,
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

// A Guitar Pro import in miniature: vocals kept on a tab staff, a guitar on
// tab only, a bass with a staff of notes and an empty tab staff, a drum kit
// that the score hides, and an empty second kit.
const IMPORTED = `<museScore><Score>
    <Part id="1">
      <Staff>
        <StaffType group="tablature"><name>tab6StrFull</name></StaffType>
        </Staff>
      <trackName>Lead Vocals</trackName>
      <Instrument id="voice"><instrumentId>voice.vocals</instrumentId><StringData><string>40</string></StringData></Instrument>
      </Part>
    <Part id="2">
      <Staff>
        <StaffType group="tablature"><name>tab6StrFull</name></StaffType>
        <defaultClef>TAB</defaultClef>
        </Staff>
      <trackName>Rhythm Guitar &amp; Lead</trackName>
      <Instrument id="electric-guitar"><instrumentId>pluck.guitar.electric</instrumentId>
        <StringData><frets>24</frets><string>40</string><string>45</string><string>50</string><string>55</string><string>59</string><string>64</string></StringData></Instrument>
      </Part>
    <Part id="3">
      <Staff>
        <StaffType group="pitched"><name>stdNormal</name></StaffType>
        </Staff>
      <Staff>
        <StaffType group="tablature"><name>tab4StrCommon</name></StaffType>
        </Staff>
      <trackName>Bass</trackName>
      <Instrument id="bass"><instrumentId>pluck.bass</instrumentId>
        <StringData><string>28</string><string>33</string><string>38</string><string>43</string></StringData></Instrument>
      </Part>
    <Part id="4">
      <show>0</show>
      <Staff>
        <StaffType group="percussion"><name>perc5Line</name></StaffType>
        </Staff>
      <trackName>Drums</trackName>
      <Instrument id="drumset"><instrumentId>drum.group.set</instrumentId></Instrument>
      </Part>
    <Part id="5">
      <Staff>
        <StaffType group="percussion"><name>perc5Line</name></StaffType>
        </Staff>
      <trackName>Spare kit</trackName>
      <Instrument id="drumset"><instrumentId>drum.group.set</instrumentId></Instrument>
      </Part>
    <Staff id="1"><Measure><Note><pitch>60</pitch></Note><Clef><concertClefType>TAB</concertClefType></Clef></Measure></Staff>
    <Staff id="2"><Measure><Clef><concertClefType>TAB</concertClefType><transposingClefType>TAB</transposingClefType></Clef><Note><pitch>52</pitch></Note></Measure></Staff>
    <Staff id="3"><Measure><Note><pitch>40</pitch></Note></Measure></Staff>
    <Staff id="4"><Measure><Rest/></Measure></Staff>
    <Staff id="5"><Measure><Note><pitch>36</pitch></Note></Measure></Staff>
    <Staff id="6"><Measure><Rest/></Measure></Staff>
    </Score></museScore>`;

const partOf = (xml: string, id: string) => new RegExp(`<Part id="${id}">[\\s\\S]*?</Part>`).exec(xml)![0];
const musicOf = (xml: string, number: number) => new RegExp(`<Staff id="${number}">[\\s\\S]*?</Staff>`).exec(xml)![0];
const stavesOf = (part: string) => [...part.matchAll(/<Staff>[\s\S]*?<\/Staff>/g)].map((match) => match[0]);

describe("voices", () => {
  const instruments = readScoreInstruments(IMPORTED);
  const voices = planVoices(instruments);
  const voice = (stem: string) => voices.find((candidate) => candidate.stem === stem)!;
  const shownParts = (xml: string) => [...xml.matchAll(/<Part id="(\d)">([\s\S]*?)<\/Part>/g)]
    .filter((match) => !match[2]!.includes("<show>0</show>")).map((match) => match[1]);

  it("reads every instrument with its staves, numbered across the score", () => {
    expect(instruments.map((instrument) => [instrument.id, instrument.name, instrument.fretted, instrument.hidden])).toEqual([
      ["1", "Lead Vocals", false, false],
      ["2", "Rhythm Guitar & Lead", true, false],
      ["3", "Bass", true, false],
      ["4", "Drums", false, true],
      ["5", "Spare kit", false, false]
    ]);
    expect(instruments[2]!.staves).toEqual([
      { number: 3, kind: "pitched", notes: 1 },
      { number: 4, kind: "tablature", notes: 0 }
    ]);
  });

  it("plans the full score, guitar and bass as notes and tab, the rest once, and skips empty instruments", () => {
    expect(voices.map((plan) => [plan.stem, plan.instrument, plan.notation])).toEqual([
      ["score", "score", undefined],
      ["part-1", "part-1", undefined],
      ["part-2-notes", "part-2", "notes"],
      ["part-2-tab", "part-2", "tab"],
      ["part-3-notes", "part-3", "notes"],
      ["part-3-tab", "part-3", "tab"],
      ["part-4", "part-4", undefined]
    ]);
    expect(voice("score").transform(IMPORTED)).toBe(IMPORTED);
  });

  it("shows only its own instrument, even one the score hides", () => {
    expect(shownParts(voice("part-4").transform(IMPORTED))).toEqual(["4"]);
    expect(shownParts(voice("part-2-tab").transform(IMPORTED))).toEqual(["2"]);
  });

  it("turns a tab staff into notes, clefs included", () => {
    const xml = voice("part-2-notes").transform(IMPORTED);
    expect(partOf(xml, "2")).toContain('<StaffType group="pitched">');
    expect(partOf(xml, "2")).not.toContain("<defaultClef>");
    expect(musicOf(xml, 2)).toContain("<concertClefType>G8_vb</concertClefType>");
    expect(musicOf(xml, 2)).not.toContain("TAB");
    // Other staves keep their clefs.
    expect(musicOf(xml, 1)).toContain("<concertClefType>TAB</concertClefType>");
    // The guitar's tab voice is the staff as it is.
    expect(partOf(voice("part-2-tab").transform(IMPORTED), "2")).toContain("<name>tab6StrFull</name>");
  });

  it("shows the staff with the notes and hides an empty one of the other kind", () => {
    const [pitched, tab] = stavesOf(partOf(voice("part-3-notes").transform(IMPORTED), "3"));
    expect(pitched).not.toContain("isStaffVisible");
    expect(tab).toContain("<isStaffVisible>0</isStaffVisible>");
    // As tab, the empty tab staff is no help: the staff with the notes turns
    // into a four-string tab, and the empty one stays hidden.
    const [converted, empty] = stavesOf(partOf(voice("part-3-tab").transform(IMPORTED), "3"));
    expect(converted).toContain("<name>tab4StrCommon</name>");
    expect(converted).toContain("<lines>4</lines>");
    expect(empty).toContain("<isStaffVisible>0</isStaffVisible>");
  });

  it("reads vocals as notes, even when the import stored them as tab", () => {
    expect(partOf(voice("part-1").transform(IMPORTED), "1")).toContain('<StaffType group="pitched">');
  });

  it("turns multimeasure rests off", () => {
    expect(withoutMultimeasureRests("<createMultiMeasureRests>1</createMultiMeasureRests>"))
      .toBe("<createMultiMeasureRests>0</createMultiMeasureRests>");
  });

  it("builds one conversion job entry per voice", () => {
    expect(buildExportJob(["score", "part-2-tab"])).toEqual([
      { in: "score.mscz", out: ["score.svg", "score.mpos", "score.spos"] },
      { in: "part-2-tab.mscz", out: ["part-2-tab.svg", "part-2-tab.mpos", "part-2-tab.spos"] }
    ]);
  });
});

describe("export files and ids", () => {
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
    expect(exportFiles(manifest)).toContain("part-1-tab-1.svg");
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

describe("rehearsal marks and time signatures", () => {
  const xml = [
    "<Part id=\"1\"><Staff id=\"1\"></Staff></Part>",
    "<Staff id=\"1\">",
    "<VBox><Text><text>Title</text></Text></VBox>",
    "<Measure len=\"1/4\"><voice><TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig><Chord/></voice></Measure>",
    "<Measure><voice><RehearsalMark><eid>x</eid><text><b>Verse</b> 1 &amp; 2</text></RehearsalMark><Chord/></voice></Measure>",
    "<Measure><voice><Chord/></voice></Measure>",
    "<Measure><voice><TimeSig><sigN>3</sigN><sigD>4</sigD></TimeSig><RehearsalMark><text>B</text></RehearsalMark></voice></Measure>",
    "<Measure><voice><TimeSig><sigN>3</sigN><sigD>4</sigD></TimeSig></voice></Measure>",
    "</Staff>",
    "<Staff id=\"2\"><Measure><voice><RehearsalMark><text>Not top staff</text></RehearsalMark></voice></Measure></Staff>"
  ].join("\n");

  it("reads them from the top staff, by measure index, frames skipped", () => {
    expect(readScoreMarks(xml)).toEqual({
      sections: [{ m: 1, label: "Verse 1 & 2" }, { m: 3, label: "B" }],
      meters: [{ m: 0, n: 4, d: 4 }, { m: 3, n: 3, d: 4 }]
    });
    expect(readScoreMarks("<Score></Score>")).toEqual({ sections: [], meters: [] });
  });

  it("puts them into the timing map, within its measures", () => {
    const timing = buildScoreTiming(mpos, spos, [A4], {
      sections: [{ m: 2, label: "A" }, { m: 500, label: "Nowhere" }],
      meters: [{ m: 0, n: 4, d: 4 }]
    });
    expect(timing.sections).toEqual([{ m: 2, label: "A" }]);
    expect(timing.meters).toEqual([{ m: 0, n: 4, d: 4 }]);
    expect(buildScoreTiming(mpos, spos, [A4]).sections).toBeUndefined();
  });
});
