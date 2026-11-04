// Drum parts of converted Guitar Pro imports, written the way drummers read
// them: hands (snare, hi-hat, cymbals, toms) stems up in voice 1, feet (bass
// drum, hi-hat pedal) stems down in voice 2. MuseScore's Guitar Pro import puts
// every drum note into one voice, so a kick, a snare and a hi-hat end up in one
// up-stemmed chord -- unlike Songsterr, which draws the same file in two voices.
//
// Voice 2 follows voice 1's rhythm (so tuplets stay whole and tie spanners,
// which point to relative positions, stay right); the rests that leaves are
// then merged into the values a drum chart would show.

/** Bass drums and the hi-hat pedal: played with the feet. */
export const FOOT_PITCHES = new Set([35, 36, 44]);

const TICKS: Record<string, number> = {
  breve: 3840,
  whole: 1920,
  half: 960,
  quarter: 480,
  eighth: 240,
  "16th": 120,
  "32nd": 60,
  "64th": 30,
  "128th": 15
};
const WHOLE = TICKS.whole!;

/**
 * Splits hands and feet into two voices on the given staves (global staff
 * numbers, as `<Staff id>` counts them), and tells the kit's drumset which
 * voice and stem each drum gets. A measure that already has a second voice is
 * left as it is.
 */
export function splitDrumVoices(xml: string, staffNumbers: number[]): string {
  if (!staffNumbers.length) {
    return xml;
  }
  const lastPart = xml.lastIndexOf("</Part>");
  if (lastPart < 0) {
    return xml;
  }
  const musicStart = lastPart + "</Part>".length;
  const head = xml.slice(0, musicStart).replace(/<Part id="[^"]+">[\s\S]*?<\/Part>/g, (part) =>
    /<StaffType group="percussion"/.test(part) ? withDrumsetVoices(part) : part);
  const music = xml.slice(musicStart).replace(/<Staff id="(\d+)">[\s\S]*?(?=<Staff id="|<\/Score>)/g, (staff, number: string) =>
    staffNumbers.includes(Number(number)) ? splitStaff(staff) : staff);
  return head + music;
}

/** Feet: voice 2, stems down. Hands: voice 1, stems up. */
function withDrumsetVoices(part: string): string {
  return part.replace(/<Drum pitch="(\d+)">([\s\S]*?)<\/Drum>/g, (_drum, pitch: string, body: string) => {
    const foot = FOOT_PITCHES.has(Number(pitch));
    let next = setTag(body, "voice", foot ? "1" : "0");
    next = setTag(next, "stem", foot ? "2" : "1");
    return `<Drum pitch="${pitch}">${next}</Drum>`;
  });
}

function setTag(body: string, tag: string, value: string): string {
  const pattern = new RegExp(`<${tag}>[^<]*</${tag}>`);
  return pattern.test(body) ? body.replace(pattern, `<${tag}>${value}</${tag}>`) : `\n          <${tag}>${value}</${tag}>${body}`;
}

interface Meter {
  n: number;
  d: number;
}

function splitStaff(staff: string): string {
  let meter: Meter = { n: 4, d: 4 };
  return staff.replace(/(<Measure\b[^>]*>)([\s\S]*?)(<\/Measure>)/g, (whole, open: string, body: string, close: string) => {
    const voices = [...body.matchAll(/<voice>([\s\S]*?)<\/voice>/g)];
    const sig = /<TimeSig>[\s\S]*?<sigN>(\d+)<\/sigN>[\s\S]*?<sigD>(\d+)<\/sigD>/.exec(body);
    if (sig) {
      meter = { n: Number(sig[1]), d: Number(sig[2]) };
    }
    if (voices.length !== 1) {
      return whole;
    }
    const split = splitMeasure(childElements(voices[0]![1]!), meter);
    if (!split) {
      return whole;
    }
    const indent = "\n          ";
    const voice = (elements: string[]) => `<voice>${indent}${elements.join(indent)}\n          </voice>`;
    const replaced = body.replace(/<voice>[\s\S]*?<\/voice>/, () => `${voice(split.hands)}\n        ${voice(split.feet)}`);
    return `${open}${replaced}${close}`;
  });
}

/** One measure's voice as hands and feet, or undefined when it has no feet to move. */
export function splitMeasure(elements: string[], meter: Meter): { hands: string[]; feet: string[] } | undefined {
  const hands: Item[] = [];
  const feet: Item[] = [];
  let graces: string[] = [];
  let tupletDepth = 0;
  let scale = 1;
  const scales: number[] = [];
  let movedAny = false;

  for (const element of elements) {
    const tag = tagName(element);
    if (tag === "Chord" && isGrace(element)) {
      graces.push(element);
      continue;
    }
    if (tag === "Chord") {
      const notes = childElements(inner(element)).filter((child) => tagName(child) === "Note");
      const foot = notes.filter((note) => FOOT_PITCHES.has(pitchOf(note)));
      const ticks = ticksOf(element) * scale;
      const inTuplet = tupletDepth > 0;
      if (!foot.length) {
        hands.push(...graces.map(other), { xml: element, ticks, inTuplet });
        feet.push(restItem(element, ticks, inTuplet));
      } else if (foot.length === notes.length) {
        movedAny = true;
        hands.push(restItem(element, ticks, inTuplet));
        feet.push(...graces.map(other), { xml: element, ticks, inTuplet });
      } else {
        movedAny = true;
        hands.push(...graces.map(other), { xml: foot.reduce((chord, note) => chord.replace(note, ""), element), ticks, inTuplet });
        feet.push({ xml: footChord(element, foot), ticks, inTuplet });
      }
      graces = [];
      continue;
    }
    if (tag === "Rest") {
      const ticks = ticksOf(element) * scale;
      const inTuplet = tupletDepth > 0;
      hands.push({ xml: element, ticks, inTuplet, rest: true });
      feet.push({ xml: restXml(element), ticks, inTuplet, rest: true });
      continue;
    }
    if (tag === "Tuplet") {
      const normal = Number(/<normalNotes>(\d+)<\/normalNotes>/.exec(element)?.[1]);
      const actual = Number(/<actualNotes>(\d+)<\/actualNotes>/.exec(element)?.[1]);
      scales.push(scale);
      scale *= normal > 0 && actual > 0 ? normal / actual : 1;
      tupletDepth += 1;
      hands.push(other(element));
      feet.push(other(withoutEids(element)));
      continue;
    }
    if (tag === "endTuplet") {
      tupletDepth = Math.max(0, tupletDepth - 1);
      scale = scales.pop() ?? 1;
      hands.push(other(element));
      feet.push(other(element));
      continue;
    }
    // Clefs, signatures, bar lines, dynamics, texts, spanners: voice 1's.
    hands.push(other(element));
  }
  // Grace notes with nothing after them stay where they were.
  hands.push(...graces.map(other));
  if (!movedAny) {
    return undefined;
  }

  const measureTicks = Math.round(hands.reduce((sum, item) => sum + (item.ticks ?? 0), 0));
  const feetEmpty = feet.every((item) => item.rest || item.ticks === undefined);
  return {
    hands: mergeRests(hands, meter, measureTicks),
    feet: feetEmpty && !feet.some((item) => item.inTuplet)
      ? [measureRest(measureTicks, meter)]
      : mergeRests(feet, meter, measureTicks)
  };
}

interface Item {
  xml: string;
  /** Time the element takes; undefined for markers that take none. */
  ticks?: number;
  inTuplet?: boolean;
  rest?: boolean;
}

function other(xml: string): Item {
  return { xml };
}

function restItem(chord: string, ticks: number, inTuplet: boolean): Item {
  return { xml: restXml(chord), ticks, inTuplet, rest: true };
}

/** A rest as long as `element` (a chord or a rest). */
function restXml(element: string): string {
  const type = /<durationType>([^<]+)<\/durationType>/.exec(element)?.[1] ?? "quarter";
  const dots = /<dots>(\d+)<\/dots>/.exec(element)?.[1];
  const duration = type === "measure" ? /<duration>([^<]+)<\/duration>/.exec(element)?.[1] : undefined;
  return `<Rest>${dots ? `<dots>${dots}</dots>` : ""}<durationType>${type}</durationType>${duration ? `<duration>${duration}</duration>` : ""}</Rest>`;
}

/** The chord's rhythm with only the foot notes (articulations stay with the hands). */
function footChord(chord: string, notes: string[]): string {
  const dots = /<dots>(\d+)<\/dots>/.exec(chord)?.[1];
  const type = /<durationType>([^<]+)<\/durationType>/.exec(chord)?.[1] ?? "quarter";
  return `<Chord>${dots ? `<dots>${dots}</dots>` : ""}<durationType>${type}</durationType>${notes.join("")}</Chord>`;
}

/**
 * Runs of rests outside tuplets, rewritten as the fewest rests a chart would
 * use: aligned to their own length, never across a beat when shorter than
 * one, and in compound time (6/8, 12/8) by dotted beats.
 */
function mergeRests(items: Item[], meter: Meter, measureTicks: number): string[] {
  const out: string[] = [];
  let position = 0;
  let run: { start: number; end: number } | undefined;
  const flush = () => {
    if (run) {
      out.push(...restsFor(run.start, run.end, meter, measureTicks));
      run = undefined;
    }
  };
  for (const item of items) {
    if (item.rest && !item.inTuplet && item.ticks !== undefined && Number.isInteger(item.ticks)) {
      run ??= { start: position, end: position };
      run.end += item.ticks;
      position += item.ticks;
      continue;
    }
    flush();
    out.push(item.xml);
    position += item.ticks ?? 0;
  }
  flush();
  return out;
}

const REST_VALUES: { ticks: number; type: string; dots: number }[] = [
  { ticks: 1920, type: "whole", dots: 0 },
  { ticks: 1440, type: "half", dots: 1 },
  { ticks: 960, type: "half", dots: 0 },
  { ticks: 720, type: "quarter", dots: 1 },
  { ticks: 480, type: "quarter", dots: 0 },
  { ticks: 240, type: "eighth", dots: 0 },
  { ticks: 120, type: "16th", dots: 0 },
  { ticks: 60, type: "32nd", dots: 0 },
  { ticks: 30, type: "64th", dots: 0 },
  { ticks: 15, type: "128th", dots: 0 }
];

export function restsFor(start: number, end: number, meter: Meter, measureTicks: number): string[] {
  if (start === 0 && end >= measureTicks && measureTicks > 0) {
    return [measureRest(measureTicks, meter)];
  }
  const compound = meter.d === 8 && meter.n % 3 === 0 && meter.n > 3;
  const beat = compound ? 720 : WHOLE / meter.d;
  const rests: string[] = [];
  let position = start;
  while (position < end) {
    const fits = REST_VALUES.find(({ ticks, dots }) => {
      if (position + ticks > end) {
        return false;
      }
      if (ticks < beat) {
        // Inside one beat, on its own grid.
        return dots === 0 && position % ticks === 0 && Math.floor(position / beat) === Math.floor((position + ticks - 1) / beat);
      }
      // A beat or more: starts on a beat, whole beats long; in simple time also
      // on its own grid (a half rest on beat 1 or 3), dotted only in compound.
      return position % beat === 0 && ticks % beat === 0 && (compound ? true : dots === 0 && position % ticks === 0);
    });
    const value = fits ?? REST_VALUES[REST_VALUES.length - 1]!;
    rests.push(`<Rest>${value.dots ? `<dots>${value.dots}</dots>` : ""}<durationType>${value.type}</durationType></Rest>`);
    position += value.ticks;
  }
  return rests;
}

function measureRest(measureTicks: number, meter: Meter): string {
  const unit = WHOLE / meter.d;
  const duration = measureTicks % unit === 0 ? `${measureTicks / unit}/${meter.d}` : reduced(measureTicks, WHOLE);
  return `<Rest><durationType>measure</durationType><duration>${duration}</duration></Rest>`;
}

function reduced(numerator: number, denominator: number): string {
  const divisor = gcd(numerator, denominator);
  return `${numerator / divisor}/${denominator / divisor}`;
}

function gcd(left: number, right: number): number {
  return right ? gcd(right, left % right) : left;
}

/** Length of a chord or rest in ticks (quarter = 480), tuplets not applied. */
export function ticksOf(element: string): number {
  const type = /<durationType>([^<]+)<\/durationType>/.exec(element)?.[1];
  if (type === "measure") {
    const [numerator, denominator] = (/<duration>(\d+)\/(\d+)<\/duration>/.exec(element) ?? []).slice(1).map(Number);
    return numerator && denominator ? (WHOLE * numerator) / denominator : 0;
  }
  const base = TICKS[type ?? ""] ?? 0;
  const dots = Number(/<dots>(\d+)<\/dots>/.exec(element)?.[1] ?? 0);
  return base * (2 - 1 / 2 ** dots);
}

function isGrace(chord: string): boolean {
  return /<(acciaccatura|appoggiatura|grace4|grace16|grace32|grace8after|grace16after|grace32after)\/>/.test(chord);
}

function pitchOf(note: string): number {
  return Number(/<pitch>(\d+)<\/pitch>/.exec(note)?.[1]);
}

function withoutEids(xml: string): string {
  return xml.replace(/\s*<eid>[^<]*<\/eid>/g, "");
}

function tagName(element: string): string {
  return /^<([A-Za-z][\w-]*)/.exec(element)?.[1] ?? "";
}

function inner(element: string): string {
  const open = element.indexOf(">");
  const close = element.lastIndexOf("</");
  return open >= 0 && close > open ? element.slice(open + 1, close) : "";
}

/** The top-level elements of an XML fragment, as written. */
export function childElements(fragment: string): string[] {
  const elements: string[] = [];
  let depth = 0;
  let start = -1;
  for (const match of fragment.matchAll(/<(\/?)([A-Za-z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const closing = match[1] === "/";
    const selfClosing = match[3] === "/";
    const index = match.index ?? 0;
    if (closing) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        elements.push(fragment.slice(start, index + match[0].length));
        start = -1;
      }
    } else if (selfClosing) {
      if (depth === 0) {
        elements.push(match[0]);
      }
    } else {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    }
  }
  return elements;
}
