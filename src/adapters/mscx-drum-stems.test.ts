import { describe, expect, it } from "vitest";
import { drumStemsDown, stemDown } from "./mscx-drum-stems.js";

const note = (pitch: number) => `<Note><pitch>${pitch}</pitch></Note>`;
const chord = (type: string, ...pitches: number[]) => `<Chord><durationType>${type}</durationType>${pitches.map(note).join("")}</Chord>`;

// A Guitar Pro import's kit in miniature: everything in one voice, the drumset
// saying stem up for every drum; a guitar on staff 2.
function score(drums: string, guitar = chord("whole", 64)): string {
  return `<museScore><Score>
    <Part id="1">
      <Staff><StaffType group="percussion"><name>perc5Line</name></StaffType></Staff>
      <Instrument id="drumset">
        <Drum pitch="36"><head>normal</head><line>7</line><voice>0</voice><name>Bass Drum 1</name><stem>1</stem></Drum>
        <Drum pitch="42"><head>cross</head><line>-1</line><voice>1</voice><name>Closed Hi-Hat</name><stem>1</stem></Drum>
        </Instrument>
      </Part>
    <Part id="2">
      <Staff><StaffType group="pitched"><name>stdNormal</name></StaffType></Staff>
      </Part>
    <Staff id="1">
      <Measure>
        <voice>${drums}</voice>
        </Measure>
      </Staff>
    <Staff id="2">
      <Measure>
        <voice>${guitar}</voice>
        </Measure>
      </Staff>
    </Score></museScore>`;
}

const BEAT = `${chord("quarter", 36, 42)}${chord("quarter", 42)}<Rest><durationType>half</durationType></Rest>`;

describe("drumStemsDown", () => {
  it("turns every drum stem down and keeps the notes together in one voice", () => {
    const xml = drumStemsDown(score(BEAT), [1]);
    const drums = /<Staff id="1">[\s\S]*?(?=<Staff id="2")/.exec(xml)![0];
    expect(drums.match(/<StemDirection>down<\/StemDirection>/g)).toHaveLength(2);
    expect(drums.match(/<voice>/g)).toHaveLength(1);
    // Kick and hi-hat stay one chord.
    expect(drums).toMatch(/<Chord>[^]*?<pitch>36<\/pitch>[^]*?<pitch>42<\/pitch>[^]*?<\/Chord>/);
  });

  it("tells the drumset: voice 1, stem down", () => {
    const xml = drumStemsDown(score(BEAT), [1]);
    for (const pitch of [36, 42]) {
      const drum = new RegExp(`<Drum pitch="${pitch}">([\\s\\S]*?)</Drum>`).exec(xml)![1]!;
      expect(drum).toContain("<voice>0</voice>");
      expect(drum).toContain("<stem>2</stem>");
    }
  });

  it("leaves other staves alone", () => {
    const xml = drumStemsDown(score(BEAT), [1]);
    expect(/<Staff id="2">[\s\S]*/.exec(xml)![0]).not.toContain("StemDirection");
    expect(drumStemsDown(score(BEAT), [])).toBe(score(BEAT));
  });
});

describe("stemDown", () => {
  it("replaces a stem direction the chord already has", () => {
    expect(stemDown("<Chord><durationType>eighth</durationType><StemDirection>up</StemDirection></Chord>"))
      .toBe("<Chord><durationType>eighth</durationType><StemDirection>down</StemDirection></Chord>");
  });
});
