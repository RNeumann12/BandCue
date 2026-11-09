import { describe, expect, it } from "vitest";
import { buildDrumLegend, drumKeyEntries, drumLegendStyle, shortDrumName } from "./mscx-drum-legend.js";

const note = (pitch: number, head = "") => `<Note><pitch>${pitch}</pitch><tpc>14</tpc>${head ? `<head>${head}</head>` : ""}</Note>`;

// A kit of four drums, of which the song plays three; a guitar part next to it.
const SCORE = `<museScore version="4.70"><Score>
    <metaTag name="workTitle">Song</metaTag>
    <Part id="1">
      <Staff><StaffType group="pitched"><name>stdNormal</name></StaffType></Staff>
      </Part>
    <Part id="2">
      <show>0</show>
      <Staff><StaffType group="percussion"><name>perc5Line</name></StaffType></Staff>
      <Staff><StaffType group="percussion"><name>perc5Line</name></StaffType><isStaffVisible>0</isStaffVisible></Staff>
      <Instrument id="drumset">
        <Drum pitch="36"><head>normal</head><line>7</line><name>Bass Drum 1</name><stem>2</stem></Drum>
        <Drum pitch="38"><head>normal</head><line>3</line><name>Acoustic Snare</name><stem>2</stem></Drum>
        <Drum pitch="46"><head>cross</head><line>-1</line><name>Open Hi-Hat</name><stem>2</stem></Drum>
        <Drum pitch="49"><head>cross</head><line>-2</line><name>Crash Cymbal 1</name><stem>2</stem></Drum>
        </Instrument>
      </Part>
    <Staff id="1">
      <Measure><voice><Chord><durationType>whole</durationType>${note(64)}</Chord></voice></Measure>
      </Staff>
    <Staff id="2">
      <Measure><voice>
        <Chord><durationType>quarter</durationType>${note(36)}${note(46, "xcircle")}</Chord>
        <Chord><durationType>quarter</durationType>${note(38)}${note(46, "xcircle")}</Chord>
        <Chord><durationType>half</durationType>${note(46)}</Chord>
        </voice></Measure>
      </Staff>
    <Staff id="3">
      <Measure><voice><Chord><durationType>whole</durationType>${note(49)}</Chord></voice></Measure>
      </Staff>
    </Score></museScore>`;

describe("drumKeyEntries", () => {
  it("lists the drums the staff plays, top line first, with their usual notehead", () => {
    expect(drumKeyEntries(SCORE, "2", [2])).toEqual([
      { pitch: 46, name: "Open Hi-Hat", line: -1, head: "xcircle", tpc: "14" },
      { pitch: 38, name: "Snare", line: 3, head: undefined, tpc: "14" },
      { pitch: 36, name: "Kick", line: 7, head: undefined, tpc: "14" }
    ]);
  });

  it("is empty for a part without a drumset", () => {
    expect(drumKeyEntries(SCORE, "1", [1])).toEqual([]);
  });
});

describe("shortDrumName", () => {
  it("says it the way a drum chart does", () => {
    expect(["Bass Drum 1", "Acoustic Bass Drum", "Acoustic Snare", "Crash Cymbal 1", "Closed Hi-Hat", "Ride Bell", "Low Floor Tom"]
      .map(shortDrumName)).toEqual(["Kick", "Kick", "Snare", "Crash", "Hi-Hat", "Ride Bell", "Low Floor Tom"]);
  });

  it("keeps the full names when two drums would read the same", () => {
    const twoKicks = SCORE
      .replace('<Drum pitch="38"><head>normal</head><line>3</line><name>Acoustic Snare</name>', '<Drum pitch="38"><head>normal</head><line>3</line><name>Acoustic Bass Drum</name>');
    expect(drumKeyEntries(twoKicks, "2", [2]).map((entry) => entry.name)).toEqual(["Open Hi-Hat", "Acoustic Bass Drum", "Bass Drum 1"]);
  });
});

describe("buildDrumLegend", () => {
  const legend = buildDrumLegend(SCORE, "2", [2], 0)!;

  it("keeps only the kit, shown, with one staff", () => {
    expect(legend).not.toContain('<Part id="1">');
    expect(legend).toContain('<Part id="2">');
    expect(legend).not.toContain("<show>0</show>");
    expect(legend.match(/<Staff>/g)).toHaveLength(1);
    expect(legend.match(/<Staff id="/g)).toEqual(['<Staff id="']);
    expect(legend).toMatch(/<\/Score>\s*<\/museScore>\s*$/);
  });

  it("writes one measure of a quarter note per drum, stems down, named underneath", () => {
    expect(legend).toContain('<Measure len="3/4">');
    expect(legend.match(/<StemDirection>down<\/StemDirection>/g)).toHaveLength(3);
    expect([...legend.matchAll(/<Lyrics><text>([^<]+)<\/text><\/Lyrics>/g)].map((match) => match[1])).toEqual(["Open Hi-Hat", "Snare", "Kick"]);
    expect(legend).toContain("<head>xcircle</head>");
    expect(legend).not.toContain("<TimeSig>");
  });

  it("puts a big kit on two rows, one line of names each", () => {
    const pitches = [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47];
    const bigKit = SCORE
      .replace(/<Drum pitch="36">[\s\S]*?<\/Instrument>/, `${pitches.map((pitch) =>
        `<Drum pitch="${pitch}"><line>${pitch - 40}</line><name>Drum ${pitch}</name></Drum>`).join("")}</Instrument>`)
      .replace(/(<Staff id="2">\s*<Measure><voice>)/, `$1<Chord><durationType>whole</durationType>${pitches.map((pitch) => note(pitch)).join("")}</Chord>`);
    const big = buildDrumLegend(bigKit, "2", [2])!;
    expect([...big.matchAll(/<Measure len="(\d+)\/4">/g)].map((match) => match[1])).toEqual(["7", "6"]);
    expect(big.match(/<subtype>line<\/subtype>/g)).toHaveLength(1);
    expect(big).not.toContain("<no>");
  });

  it("is undefined when the part plays nothing it can name", () => {
    expect(buildDrumLegend(SCORE, "1", [1])).toBeUndefined();
  });
});

describe("drumLegendStyle", () => {
  it("keeps a short key short and its names apart", () => {
    const tight = drumLegendStyle("<Style><lastSystemFillLimit>0.3</lastSystemFillLimit><lyricsMinDistance>0.25</lyricsMinDistance></Style>");
    expect(tight).toMatch(/^<Style><lastSystemFillLimit>1<\/lastSystemFillLimit><lyricsMinDistance>2<\/lyricsMinDistance>/);
    const empty = drumLegendStyle("<Style></Style>");
    expect(empty).toContain("<lastSystemFillLimit>1</lastSystemFillLimit>");
    expect(empty).toContain("<lyricsMinDistance>2</lyricsMinDistance>");
    expect(empty).toContain("<showMeasureNumber>0</showMeasureNumber>");
  });
});
