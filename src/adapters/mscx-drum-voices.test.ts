import { describe, expect, it } from "vitest";
import { childElements, restsFor, splitDrumVoices, ticksOf } from "./mscx-drum-voices.js";

const note = (pitch: number) => `<Note><pitch>${pitch}</pitch><Spanner type="Tie"><next/></Spanner></Note>`;
const chord = (type: string, ...pitches: number[]) => `<Chord><durationType>${type}</durationType>${pitches.map(note).join("")}</Chord>`;

// A Guitar Pro import's kit in miniature: everything in one voice, the drumset
// saying voice 1 / stem up for every drum.
function score(...measures: string[]): string {
  return `<museScore><Score>
    <Part id="1">
      <Staff><StaffType group="percussion"><name>perc5Line</name></StaffType></Staff>
      <Instrument id="drumset">
        <Drum pitch="36"><head>normal</head><line>7</line><voice>0</voice><name>Bass Drum 1</name><stem>1</stem></Drum>
        <Drum pitch="38"><head>normal</head><line>3</line><voice>0</voice><name>Acoustic Snare</name><stem>1</stem></Drum>
        <Drum pitch="42"><head>cross</head><line>-1</line><voice>0</voice><name>Closed Hi-Hat</name><stem>1</stem></Drum>
        </Instrument>
      </Part>
    <Staff id="1">
${measures.map((body) => `      <Measure>\n        <voice>${body}</voice>\n        </Measure>`).join("\n")}
      </Staff>
    </Score></museScore>`;
}

function voicesOf(xml: string): string[][] {
  return [...xml.matchAll(/<Measure>([\s\S]*?)<\/Measure>/g)].map((measure) =>
    [...measure[1]!.matchAll(/<voice>([\s\S]*?)<\/voice>/g)].map((voice) => voice[1]!));
}

const ROCK_BEAT = [
  chord("eighth", 36, 42), chord("eighth", 42), chord("eighth", 38, 42), chord("eighth", 42),
  chord("eighth", 36, 42), chord("eighth", 36, 42), chord("eighth", 38, 42), chord("eighth", 42)
].join("");

describe("splitDrumVoices", () => {
  it("puts the feet in a second voice and keeps the hands' rhythm", () => {
    const [[hands, feet]] = voicesOf(splitDrumVoices(score(ROCK_BEAT), [1]));
    const handChords = childElements(hands!).filter((element) => element.startsWith("<Chord"));
    expect(handChords).toHaveLength(8);
    expect(hands).not.toContain("<pitch>36</pitch>");
    expect(feet).not.toContain("<pitch>38</pitch>");
    expect(feet).not.toContain("<pitch>42</pitch>");
    // Kick on 1, the "and" of 3 and 4; rests merged in between.
    expect(childElements(feet!).map((element) => /<pitch>36/.test(element) ? "K" : /<durationType>([^<]+)/.exec(element)![1]))
      .toEqual(["K", "eighth", "quarter", "K", "K", "quarter"]);
  });

  it("fills both voices to the same length, the ties going with their notes", () => {
    const [[hands, feet]] = voicesOf(splitDrumVoices(score(ROCK_BEAT), [1]));
    const length = (voice: string) => childElements(voice).reduce((sum, element) => sum + ticksOf(element), 0);
    expect(length(hands!)).toBe(1920);
    expect(length(feet!)).toBe(1920);
    expect(feet!.match(/<Spanner type="Tie">/g)).toHaveLength(3);
  });

  it("gives the drumset's feet voice 2 and stems down", () => {
    const xml = splitDrumVoices(score(ROCK_BEAT), [1]);
    expect(xml).toMatch(/<Drum pitch="36">[\s\S]*?<voice>1<\/voice>[\s\S]*?<stem>2<\/stem>/);
    expect(xml).toMatch(/<Drum pitch="38">[\s\S]*?<voice>0<\/voice>[\s\S]*?<stem>1<\/stem>/);
  });

  it("writes a whole-measure rest for a bar without feet, and leaves bars with nothing to move", () => {
    const handsOnly = chord("half", 38).repeat(2);
    const xml = splitDrumVoices(score(ROCK_BEAT, handsOnly), [1]);
    const [, second] = voicesOf(xml);
    expect(second).toHaveLength(1);
    expect(second![0]).toBe(handsOnly);
    const [[, feet]] = voicesOf(splitDrumVoices(score(`${chord("half", 38)}${chord("half", 36)}`), [1]));
    expect(childElements(feet!)[0]).toBe("<Rest><durationType>half</durationType></Rest>");
  });

  it("keeps tuplets whole in both voices", () => {
    const triplet = `<Tuplet><eid>A</eid><normalNotes>2</normalNotes><actualNotes>3</actualNotes><baseNote>eighth</baseNote></Tuplet>` +
      `${chord("eighth", 36, 42)}${chord("eighth", 42)}${chord("eighth", 38)}<endTuplet/>${chord("quarter", 36)}${chord("half", 38)}`;
    const [[hands, feet]] = voicesOf(splitDrumVoices(score(triplet), [1]));
    for (const voice of [hands!, feet!]) {
      expect(voice.match(/<Tuplet>/g)).toHaveLength(1);
      expect(voice.match(/<endTuplet\/>/g)).toHaveLength(1);
    }
    expect(feet).not.toContain("<eid>A</eid>");
    // Inside the triplet: kick, then two eighth rests; never merged across it.
    expect(childElements(feet!).slice(1, 4).map((element) => /<durationType>([^<]+)/.exec(element)![1])).toEqual(["eighth", "eighth", "eighth"]);
  });

  it("leaves measures that already have two voices and other staves alone", () => {
    const twoVoices = score(ROCK_BEAT).replace("</voice>", `</voice><voice>${chord("whole", 36)}</voice>`);
    expect(splitDrumVoices(twoVoices, [1])).toContain(`<voice>${chord("whole", 36)}</voice>`);
    expect(voicesOf(splitDrumVoices(score(ROCK_BEAT), [2]))[0]).toHaveLength(1);
  });
});

describe("restsFor", () => {
  it("never crosses a beat with a short rest and puts half rests on 1 or 3", () => {
    const types = (start: number, end: number, n = 4, d = 4) =>
      restsFor(start, end, { n, d }, (1920 * n) / d).map((rest) => (rest.includes("<dots>") ? "." : "") + /<durationType>([^<]+)/.exec(rest)![1]);
    expect(types(240, 1920)).toEqual(["eighth", "quarter", "half"]);
    expect(types(480, 1440)).toEqual(["quarter", "quarter"]);
    expect(types(0, 1440, 6, 8)).toEqual(["measure"]);
    expect(types(240, 1440, 6, 8)).toEqual(["eighth", "eighth", ".quarter"]);
  });
});
