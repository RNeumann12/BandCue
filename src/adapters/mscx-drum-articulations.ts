// Drum articulations of converted Guitar Pro imports, as Songsterr shows them.
// Guitar Pro (and so Songsterr) has more drum sounds than General MIDI: a
// rimshot, a half-open hi-hat, the edge of the ride, choked cymbals. MuseScore's
// Guitar Pro import plays each one as its plain General MIDI drum -- a rimshot
// becomes an "Electric Snare", a half-open hi-hat a closed one, a choked crash a
// crash -- so the part shows a different note than Songsterr does. The import
// keeps the Guitar Pro drum number in every drum note's <fret>, though; this
// gives each such drum its own entry in the kit's drumset again, with Guitar
// Pro's notehead and mark, so the part and its drum key say what Songsterr says.

export interface GuitarProDrum {
  /** As the drum key names it. */
  name: string;
  /** MuseScore notehead group; undefined keeps the head of the drum it replaces. */
  head?: string;
  /** With head "custom": the SMuFL notehead the drumset draws for every duration. */
  symbol?: string;
  /** A mark on the chord (MuseScore articulation symbol), like Guitar Pro's technique symbol. */
  mark?: string;
  /** Drawn in parentheses (Guitar Pro's muted hand percussion). */
  ghost?: boolean;
}

// Guitar Pro's own drum numbers beyond General MIDI (its "InputMidiNumbers"),
// with the notehead and technique symbol Guitar Pro 7 draws for each. Numbers
// that are General MIDI drums already import correctly and are not listed.
export const GUITAR_PRO_DRUMS: ReadonlyMap<number, GuitarProDrum> = new Map<number, GuitarProDrum>([
  [91, { name: "Rimshot", head: "diamond-old" }],
  [92, { name: "Half-Open Hi-Hat", head: "custom", symbol: "noteheadCircleSlash" }],
  [93, { name: "Ride Edge", head: "cross", mark: "pictEdgeOfCymbal" }],
  [94, { name: "Ride Choke", head: "cross", mark: "articStaccatoAbove" }],
  [95, { name: "Splash Choke", head: "cross", mark: "articStaccatoAbove" }],
  [96, { name: "China Choke", head: "heavy-cross-hat", mark: "articStaccatoAbove" }],
  [97, { name: "Crash Choke", head: "heavy-cross", mark: "articStaccatoAbove" }],
  [98, { name: "Crash 2 Choke", head: "heavy-cross", mark: "articStaccatoAbove" }],
  [99, { name: "Cowbell Low", head: "triangle-up" }],
  [100, { name: "Cowbell Low Tip", head: "cross" }],
  [101, { name: "Cowbell Tip", head: "cross" }],
  [102, { name: "Cowbell High", head: "triangle-up" }],
  [103, { name: "Cowbell High Tip", head: "cross" }],
  [104, { name: "Bongo High Mute", ghost: true }],
  [105, { name: "Bongo High Slap", head: "cross" }],
  [106, { name: "Bongo Low Mute", ghost: true }],
  [107, { name: "Bongo Low Slap", head: "cross" }],
  [108, { name: "Conga Low Slap", head: "cross" }],
  [109, { name: "Conga Low Mute", ghost: true }],
  [110, { name: "Conga High Slap", head: "cross" }],
  [111, { name: "Tambourine Return", head: "triangle-up", mark: "stringsUpBow" }],
  [112, { name: "Tambourine Roll", head: "triangle-up", mark: "stringsDownBow" }],
  [113, { name: "Tambourine Hand", head: "cross" }],
  [117, { name: "Cabasa Return", mark: "stringsUpBow" }],
  [118, { name: "Left Maraca Return", mark: "stringsUpBow" }],
  [119, { name: "Right Maraca" }],
  [120, { name: "Right Maraca Return", mark: "stringsUpBow" }],
  [122, { name: "Shaker Return", mark: "stringsUpBow" }],
  [123, { name: "Bell Tree Return", mark: "stringsUpBow" }],
  [126, { name: "Ride 2", head: "cross" }],
  [127, { name: "Ride 2 Bell", head: "diamond-old" }],
  [29, { name: "Ride 2 Choke", head: "cross", mark: "articStaccatoAbove" }],
  [30, { name: "Reverse Cymbal", head: "cross" }],
  [31, { name: "Side Stick", head: "slashed2" }]
]);

/** Tonal pitch class MuseScore writes for each pitch class (C, C#, D, ... B). */
const TPC = [14, 21, 16, 23, 18, 13, 20, 15, 22, 17, 24, 19];

/**
 * Gives every drum note on the given staves (global staff numbers) whose
 * <fret> holds a Guitar Pro drum number MuseScore played as something plainer
 * its own drum again: pitch = the Guitar Pro number, a drumset entry for it in
 * the kit (on the line of the drum MuseScore chose), Guitar Pro's notehead, and
 * its mark on the chord.
 */
export function restoreDrumArticulations(xml: string, staffNumbers: number[]): string {
  const lastPart = xml.lastIndexOf("</Part>");
  if (!staffNumbers.length || lastPart < 0) {
    return xml;
  }
  const musicStart = lastPart + "</Part>".length;
  // Per kit staff: Guitar Pro number -> the General MIDI pitch MuseScore gave it.
  const used = new Map<number, Map<number, number>>();
  const music = xml.slice(musicStart).replace(/<Staff id="(\d+)">[\s\S]*?(?=<Staff id="|<\/Score>)/g, (staff, number: string) => {
    if (!staffNumbers.includes(Number(number))) {
      return staff;
    }
    return staff.replace(/<Chord>[\s\S]*?<\/Chord>/g, (chord) => {
      const marks = new Set<string>();
      const rewritten = chord.replace(/<Note>([\s\S]*?)<\/Note>/g, (note, body: string) => {
        const pitch = Number(/<pitch>(\d+)<\/pitch>/.exec(body)?.[1]);
        const fret = Number(/<fret>(\d+)<\/fret>/.exec(body)?.[1]);
        const drum = GUITAR_PRO_DRUMS.get(fret);
        if (!drum || fret === pitch || !Number.isFinite(pitch)) {
          return note;
        }
        const map = used.get(Number(number)) ?? new Map<number, number>();
        map.set(fret, map.get(fret) ?? pitch);
        used.set(Number(number), map);
        if (drum.mark) {
          marks.add(drum.mark);
        }
        let next = body
          .replace(/<pitch>\d+<\/pitch>/, `<pitch>${fret}</pitch>`)
          .replace(/<tpc>-?\d+<\/tpc>/, `<tpc>${TPC[fret % 12]}</tpc>`)
          .replace(/<tpc2>-?\d+<\/tpc2>/, "")
          .replace(/\s*<Accidental>[\s\S]*?<\/Accidental>/, "");
        next = drum.head
          ? /<head>[^<]*<\/head>/.test(next)
            ? next.replace(/<head>[^<]*<\/head>/, `<head>${drum.head}</head>`)
            : next.replace(/(<tpc>-?\d+<\/tpc>)/, `$1\n              <head>${drum.head}</head>`)
          : next;
        if (drum.ghost && !/<ghost>/.test(next)) {
          next = next.replace(/(<pitch>\d+<\/pitch>)/, `<ghost>1</ghost>\n              $1`);
        }
        return `<Note>${next}</Note>`;
      });
      if (!marks.size) {
        return rewritten;
      }
      const missing = [...marks].filter((mark) => !rewritten.includes(`<subtype>${mark}</subtype>`));
      const articulations = missing.map((mark) => `<Articulation>\n              <subtype>${mark}</subtype>\n              </Articulation>\n            `).join("");
      return rewritten.replace(/(\s*)<Note>/, `$1${articulations}<Note>`);
    });
  });
  if (!used.size) {
    return xml;
  }
  const allUsed = new Map<number, number>();
  for (const map of used.values()) {
    for (const [fret, pitch] of map) {
      allUsed.set(fret, allUsed.get(fret) ?? pitch);
    }
  }
  const head = xml.slice(0, musicStart).replace(/<Part id="[^"]+">[\s\S]*?<\/Part>/g, (part) =>
    /<StaffType group="percussion"/.test(part) ? withDrums(part, allUsed) : part);
  return head + music;
}

/**
 * Gives each Guitar Pro drum its drumset entry: Guitar Pro's name, notehead and
 * line. MuseScore's import already lists some of these numbers in the kit under
 * its own names ("Open Hi-Hat" for the half-open one); those are renamed in place.
 * Missing ones are copied from the drum MuseScore chose for them.
 */
function withDrums(part: string, wanted: Map<number, number>): string {
  const drumset = new Map<number, string>();
  for (const match of part.matchAll(/<Drum pitch="(\d+)">([\s\S]*?)<\/Drum>/g)) {
    drumset.set(Number(match[1]), match[2]!);
  }
  const added: string[] = [];
  let result = part;
  for (const [fret, pitch] of wanted) {
    const existing = drumset.get(fret);
    const body = drumBody(existing ?? drumset.get(pitch) ?? "<head>normal</head><line>0</line><voice>0</voice><stem>1</stem>",
      GUITAR_PRO_DRUMS.get(fret)!, existing === undefined);
    if (existing === undefined) {
      added.push(`<Drum pitch="${fret}">${body}</Drum>`);
    } else {
      result = result.replace(`<Drum pitch="${fret}">${existing}</Drum>`, `<Drum pitch="${fret}">${body}</Drum>`);
    }
  }
  if (!added.length) {
    return result;
  }
  const lastDrum = result.lastIndexOf("</Drum>");
  return lastDrum < 0 ? result : `${result.slice(0, lastDrum + 7)}\n        ${added.join("\n        ")}${result.slice(lastDrum + 7)}`;
}

function drumBody(source: string, drum: GuitarProDrum, copied: boolean): string {
  let body = source.replace(/\s*<noteheads>[\s\S]*?<\/noteheads>/, "");
  if (copied) {
    // A copy must not take over the original's palette slot or shortcut.
    body = body
      .replace(/\s*<shortcut>[^<]*<\/shortcut>/, "")
      .replace(/\s*<panelRow>[^<]*<\/panelRow>/, "")
      .replace(/\s*<panelColumn>[^<]*<\/panelColumn>/, "");
  }
  body = /<name>/.test(body) ? body.replace(/<name>[^<]*<\/name>/, `<name>${drum.name}</name>`) : `${body}<name>${drum.name}</name>`;
  if (drum.head) {
    body = /<head>/.test(body) ? body.replace(/<head>[^<]*<\/head>/, `<head>${drum.head}</head>`) : `<head>${drum.head}</head>${body}`;
  }
  if (drum.symbol) {
    const symbol = drum.symbol;
    body = body.replace(/(<head>[^<]*<\/head>)/,
      `$1<noteheads><whole>${symbol}</whole><half>${symbol}</half><quarter>${symbol}</quarter><breve>${symbol}</breve></noteheads>`);
  }
  return body;
}
