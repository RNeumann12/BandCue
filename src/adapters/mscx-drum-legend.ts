// The drum key shown above a drum part: one note per drum the song uses, on
// its line and with its notehead, the drum's name under it. It is a tiny score
// of its own that MuseScore engraves like the part itself, so the key looks
// exactly like the notes it explains.

export interface DrumKeyEntry {
  pitch: number;
  name: string;
  /** Staff line from the drumset (negative = above the staff). */
  line: number;
  /** Notehead the song's notes use for this drum, if not the drumset's. */
  head?: string;
  tpc?: string;
}

/** Above this many drums the names take turns on two lines, so they fit. */
const ONE_LINE_OF_NAMES = 8;

/**
 * A drumset name the way a drum chart says it: "Bass Drum 1" is the kick,
 * "Crash Cymbal 1" the crash, "Acoustic Snare" the snare.
 */
export function shortDrumName(name: string): string {
  const short = name
    .replace(/\s+\d+$/, "")
    .replace(/^(Acoustic|Electric)\s+/i, "")
    .replace(/^Bass Drum$/i, "Kick")
    .replace(/^Closed Hi-Hat$/i, "Hi-Hat")
    .replace(/\s+Cymbal$/i, "")
    .trim();
  return short || name;
}

/**
 * The drums played on the given staves (global staff numbers) of the part
 * `partId`, top line first, as the part's drumset names them. Empty when the
 * part has no drumset.
 */
export function drumKeyEntries(xml: string, partId: string, staffNumbers: number[]): DrumKeyEntry[] {
  const part = partXml(xml, partId);
  if (!part) {
    return [];
  }
  const drums = new Map<number, { name: string; line: number }>();
  for (const match of part.matchAll(/<Drum pitch="(\d+)">([\s\S]*?)<\/Drum>/g)) {
    const body = match[2]!;
    drums.set(Number(match[1]), {
      name: /<name>([^<]*)<\/name>/.exec(body)?.[1]?.trim() || `Drum ${match[1]}`,
      line: Number(/<line>(-?\d+)<\/line>/.exec(body)?.[1] ?? 0)
    });
  }
  // Per drum: how often each notehead appears; the key shows the usual one.
  const played = new Map<number, { heads: Map<string, number>; tpc?: string }>();
  const music = xml.slice(xml.lastIndexOf("</Part>"));
  for (const staff of music.matchAll(/<Staff id="(\d+)">[\s\S]*?(?=<Staff id="|<\/Score>)/g)) {
    if (!staffNumbers.includes(Number(staff[1]))) {
      continue;
    }
    for (const note of staff[0].matchAll(/<Note>([\s\S]*?)<\/Note>/g)) {
      const pitch = Number(/<pitch>(\d+)<\/pitch>/.exec(note[1]!)?.[1]);
      if (!drums.has(pitch)) {
        continue;
      }
      const entry = played.get(pitch) ?? { heads: new Map<string, number>(), tpc: /<tpc>(-?\d+)<\/tpc>/.exec(note[1]!)?.[1] };
      const head = /<head>([^<]*)<\/head>/.exec(note[1]!)?.[1] ?? "";
      entry.heads.set(head, (entry.heads.get(head) ?? 0) + 1);
      played.set(pitch, entry);
    }
  }
  const entries = [...played.entries()]
    .map(([pitch, { heads, tpc }]) => {
      const drum = drums.get(pitch)!;
      const head = [...heads.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
      return { pitch, name: drum.name, line: drum.line, head: head || undefined, tpc };
    })
    .sort((left, right) => left.line - right.line || left.pitch - right.pitch);
  // Short names, unless two drums would then read the same (Crash 1 and 2).
  const shortNames = entries.map((entry) => shortDrumName(entry.name));
  return entries.map((entry, index) =>
    shortNames.indexOf(shortNames[index]!) === shortNames.lastIndexOf(shortNames[index]!) ? { ...entry, name: shortNames[index]! } : entry);
}

/**
 * A score holding only the key for part `partId`: that part (shown, with only
 * `staffIndex`'s staff), one measure of a quarter note per drum, stems down,
 * names as lyrics. Undefined when there is nothing to explain.
 */
export function buildDrumLegend(xml: string, partId: string, staffNumbers: number[], staffIndex = 0): string | undefined {
  const entries = drumKeyEntries(xml, partId, staffNumbers);
  const part = partXml(xml, partId);
  const firstPart = xml.indexOf("<Part ");
  const lastPart = xml.lastIndexOf("</Part>");
  if (!entries.length || !part || firstPart < 0 || lastPart < 0) {
    return undefined;
  }
  let index = 0;
  const onePart = part
    .replace(/\n?[ \t]*<show>0<\/show>/, "")
    .replace(/[ \t]*<Staff>[\s\S]*?<\/Staff>\n?/g, (staff) => (index++ === staffIndex ? staff : ""))
    .replace(/<isStaffVisible>0<\/isStaffVisible>/, "<isStaffVisible>1</isStaffVisible>");
  const staggered = entries.length > ONE_LINE_OF_NAMES;
  // MuseScore spaces notes, not their lyrics: room for the longest name.
  const longest = Math.max(...entries.map((entry) => decodedLength(entry.name)));
  const stretch = Math.round(Math.min(4, Math.max(1, longest * (staggered ? 0.18 : 0.35))) * 10) / 10;
  const chords = entries.map((entry, position) => [
    "<Chord>",
    "<durationType>quarter</durationType>",
    "<StemDirection>down</StemDirection>",
    `<Lyrics>${staggered && position % 2 ? "<no>1</no>" : ""}<text>${entry.name}</text></Lyrics>`,
    `<Note><pitch>${entry.pitch}</pitch>${entry.tpc ? `<tpc>${entry.tpc}</tpc>` : ""}${entry.head ? `<head>${entry.head}</head>` : ""}</Note>`,
    "</Chord>"
  ].join("\n            "));
  return `${xml.slice(0, firstPart)}${onePart}
    <Staff id="1">
      <Measure len="${entries.length}/4">
        <stretch>${stretch}</stretch>
        <voice>
          ${chords.join("\n          ")}
          </voice>
        </Measure>
      </Staff>
    </Score>
  </museScore>
`;
}

/**
 * The key's style: a short key stays short instead of being stretched across
 * the page like the last line of a piece.
 */
export function drumLegendStyle(style: string): string {
  return /<lastSystemFillLimit>[^<]*<\/lastSystemFillLimit>/.test(style)
    ? style.replace(/<lastSystemFillLimit>[^<]*<\/lastSystemFillLimit>/, "<lastSystemFillLimit>1</lastSystemFillLimit>")
    : style.replace("</Style>", "<lastSystemFillLimit>1</lastSystemFillLimit>\n    </Style>");
}

function decodedLength(text: string): number {
  return text.replace(/&[a-z]+;|&#\d+;/g, "_").length;
}

function partXml(xml: string, partId: string): string | undefined {
  return [...xml.matchAll(/<Part id="([^"]+)">[\s\S]*?<\/Part>/g)].find((match) => match[1] === partId)?.[0];
}
