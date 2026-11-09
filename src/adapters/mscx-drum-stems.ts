// Drum parts of converted Guitar Pro imports, drawn the way Songsterr draws
// them: one voice, every stem down. A kick, a snare and a hi-hat played
// together are one chord on one stem, and beams join below the staff.
// MuseScore's Guitar Pro import already writes every drum note into one voice,
// but lets each chord pick its own stem direction, so stems flip up and down
// from beat to beat.

/**
 * Turns every stem on the given staves (global staff numbers, as `<Staff id>`
 * counts them) down, and tells the kit's drumset the same: every drum in
 * voice 1, stem down.
 */
export function drumStemsDown(xml: string, staffNumbers: number[]): string {
  if (!staffNumbers.length) {
    return xml;
  }
  const lastPart = xml.lastIndexOf("</Part>");
  if (lastPart < 0) {
    return xml;
  }
  const musicStart = lastPart + "</Part>".length;
  const head = xml.slice(0, musicStart).replace(/<Part id="[^"]+">[\s\S]*?<\/Part>/g, (part) =>
    /<StaffType group="percussion"/.test(part) ? withDrumsetStemsDown(part) : part);
  const music = xml.slice(musicStart).replace(/<Staff id="(\d+)">[\s\S]*?(?=<Staff id="|<\/Score>)/g, (staff, number: string) =>
    staffNumbers.includes(Number(number)) ? staff.replace(/<Chord>[\s\S]*?<\/Chord>/g, stemDown) : staff);
  return head + music;
}

function withDrumsetStemsDown(part: string): string {
  return part.replace(/<Drum pitch="(\d+)">([\s\S]*?)<\/Drum>/g, (_drum, pitch: string, body: string) =>
    `<Drum pitch="${pitch}">${setTag(setTag(body, "voice", "0"), "stem", "2")}</Drum>`);
}

function setTag(body: string, tag: string, value: string): string {
  const pattern = new RegExp(`<${tag}>[^<]*</${tag}>`);
  return pattern.test(body) ? body.replace(pattern, `<${tag}>${value}</${tag}>`) : `\n          <${tag}>${value}</${tag}>${body}`;
}

/** One chord with its stem down (MuseScore's own `<StemDirection>` property). */
export function stemDown(chord: string): string {
  if (/<StemDirection>[^<]*<\/StemDirection>/.test(chord)) {
    return chord.replace(/<StemDirection>[^<]*<\/StemDirection>/, "<StemDirection>down</StemDirection>");
  }
  return /<\/durationType>/.test(chord)
    ? chord.replace("</durationType>", "</durationType>\n            <StemDirection>down</StemDirection>")
    : chord.replace("<Chord>", "<Chord>\n            <StemDirection>down</StemDirection>");
}
