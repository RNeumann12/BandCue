import { describe, expect, it } from "vitest";
import { restoreDrumArticulations } from "./mscx-drum-articulations.js";
import { drumKeyEntries } from "./mscx-drum-legend.js";

// A Guitar Pro import in miniature, the way MuseScore 4.7 writes one: each drum
// note keeps the Guitar Pro drum number in <fret>, while <pitch> is the plain
// General MIDI drum MuseScore plays for it. The kit already lists 92 under
// MuseScore's own name. Staff 2 is a guitar whose frets must stay untouched.
const note = (pitch: number, fret: number, head?: string) =>
  `<Note><pitch>${pitch}</pitch><tpc>14</tpc>${head ? `<head>${head}</head>` : ""}<fret>${fret}</fret><string>0</string></Note>`;
const chord = (...notes: string[]) => `<Chord><durationType>quarter</durationType>${notes.join("")}</Chord>`;

function score(drums: string, guitar = chord(note(64, 0))): string {
  return `<museScore><Score>
    <Part id="1">
      <Staff><StaffType group="percussion"><name>perc5Line</name></StaffType></Staff>
      <Instrument id="drumset">
        <Drum pitch="36"><head>normal</head><line>7</line><voice>0</voice><name>Bass Drum 1</name><stem>1</stem></Drum>
        <Drum pitch="38"><head>normal</head><line>3</line><voice>0</voice><name>Acoustic Snare</name><stem>1</stem></Drum>
        <Drum pitch="40"><head>normal</head><line>3</line><voice>0</voice><name>Electric Snare</name><stem>1</stem><shortcut>E</shortcut></Drum>
        <Drum pitch="42"><head>cross</head><line>-1</line><voice>0</voice><name>Closed Hi-Hat</name><stem>1</stem></Drum>
        <Drum pitch="49"><head>cross</head><line>-2</line><voice>0</voice><name>Crash Cymbal 1</name><stem>1</stem></Drum>
        <Drum pitch="92"><head>xcircle</head><line>-1</line><voice>0</voice><name>Open Hi-Hat</name><stem>1</stem></Drum>
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

const staff = (xml: string, n: number) => new RegExp(`<Staff id="${n}">[\\s\\S]*?(?=<Staff id="|</Score>)`).exec(xml.slice(xml.lastIndexOf("</Part>")))![0];
const drum = (xml: string, pitch: number) => new RegExp(`<Drum pitch="${pitch}">([\\s\\S]*?)</Drum>`).exec(xml)?.[1];

describe("restoreDrumArticulations", () => {
  it("gives a rimshot MuseScore played as an Electric Snare its own drum and notehead", () => {
    const xml = restoreDrumArticulations(score(chord(note(36, 36), note(40, 91))), [1]);
    const drums = staff(xml, 1);
    expect(drums).toContain("<pitch>91</pitch>");
    expect(drums).toContain("<pitch>36</pitch>");
    expect(drums).toMatch(/<pitch>91<\/pitch><tpc>15<\/tpc>\s*<head>diamond-old<\/head>/);
    // A new drumset entry on the snare's line, without the snare's shortcut.
    expect(drum(xml, 91)).toContain("<name>Rimshot</name>");
    expect(drum(xml, 91)).toContain("<line>3</line>");
    expect(drum(xml, 91)).not.toContain("<shortcut>");
    expect(drum(xml, 40)).toContain("<name>Electric Snare</name>");
  });

  it("renames the half-open hi-hat MuseScore already lists and draws Guitar Pro's notehead", () => {
    const xml = restoreDrumArticulations(score(chord(note(42, 92, "cross"))), [1]);
    expect(staff(xml, 1)).toMatch(/<pitch>92<\/pitch>[\s\S]*<head>custom<\/head>/);
    const entry = drum(xml, 92)!;
    expect(entry).toContain("<name>Half-Open Hi-Hat</name>");
    expect(entry).toContain("<head>custom</head><noteheads><whole>noteheadCircleSlash</whole>");
    expect(entry).toContain("<line>-1</line>");
    expect(xml.match(/<Drum pitch="92">/g)).toHaveLength(1);
  });

  it("marks a choked crash with Guitar Pro's staccato, once per chord", () => {
    const xml = restoreDrumArticulations(score(chord(note(36, 36), note(49, 97), note(49, 97))), [1]);
    const drums = staff(xml, 1);
    expect(drums.match(/<subtype>articStaccatoAbove<\/subtype>/g)).toHaveLength(1);
    expect(drums.indexOf("<Articulation>")).toBeLessThan(drums.indexOf("<Note>"));
    expect(drum(xml, 97)).toContain("<name>Crash Choke</name>");
    expect(drum(xml, 97)).toContain("<line>-2</line>");
  });

  it("puts the new drums in the drum key under their own names", () => {
    const xml = restoreDrumArticulations(score(chord(note(38, 38), note(42, 92, "cross")) + chord(note(40, 91))), [1]);
    expect(drumKeyEntries(xml, "1", [1]).map((entry) => entry.name)).toEqual(["Half-Open Hi-Hat", "Snare", "Rimshot"]);
  });

  it("leaves General MIDI drums, other staves and scores without Guitar Pro drums as they are", () => {
    const plain = score(chord(note(36, 36), note(42, 42, "cross")), chord(note(64, 91)));
    expect(restoreDrumArticulations(plain, [1])).toBe(plain);
    const guitarOnly = score(chord(note(36, 36)), chord(note(40, 91)));
    expect(restoreDrumArticulations(guitarOnly, [1])).toBe(guitarOnly);
    expect(restoreDrumArticulations(plain, [])).toBe(plain);
  });
});
