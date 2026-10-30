import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryContent, forcePageLayout, readZipEntries, rewriteZipText } from "./mscz-page-layout.js";
import type {
  ScoreExportReport,
  ScoreManifest,
  ScoreManifestPart,
  ScoreTiming,
  ScoreTimingEvent,
  ScoreTimingMeasure,
  ScoreTimingMeter,
  ScoreTimingSection
} from "../shared/protocol.js";

// Exports a MuseScore score for the companion page's score view: SVG pages,
// plus a timing map that says where every measure and every note onset sits on
// those pages and when it sounds. MuseScore does the hard parts itself -- its
// `mpos` (measure positions) and `spos` (segment positions) exports already list
// the measures in playback order, with repeats, D.S./Coda jumps and tempo
// changes resolved into milliseconds -- so this only reshapes them into a JSON
// file the browser can use without parsing XML. See docs/Adapters.md.

/** Bump when the export output changes shape, so cached exports are redone. */
export const SCORE_EXPORTER_VERSION = 3;
/** `mpos`/`spos` coordinates are 12 times MuseScore's SVG units (verified on 4.7.5). */
export const POSITION_UNITS_PER_SVG_UNIT = 12;
const MUSESCORE_RUN_TIMEOUT_MS = 180_000;

export interface PositionElement {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  page: number;
}

export interface PositionEvent {
  elid: number;
  position: number;
}

export interface PositionsFile {
  elements: Map<number, PositionElement>;
  events: PositionEvent[];
}

/** Parses a MuseScore `mpos` or `spos` file (both share one format). */
export function parsePositionsXml(xml: string): PositionsFile {
  const elements = new Map<number, PositionElement>();
  for (const match of xml.matchAll(/<element\b([^>]*)>/g)) {
    const attributes = parseAttributes(match[1] ?? "");
    const id = attributes.get("id");
    const x = attributes.get("x");
    const y = attributes.get("y");
    const sx = attributes.get("sx");
    const sy = attributes.get("sy");
    if ([id, x, y, sx, sy].some((value) => value === undefined)) {
      continue;
    }
    elements.set(id!, { id: id!, x: x!, y: y!, sx: sx!, sy: sy!, page: attributes.get("page") ?? 0 });
  }

  const events: PositionEvent[] = [];
  for (const match of xml.matchAll(/<event\b([^>]*)>/g)) {
    const attributes = parseAttributes(match[1] ?? "");
    const elid = attributes.get("elid");
    const position = attributes.get("position");
    if (elid !== undefined && position !== undefined && elements.has(elid)) {
      events.push({ elid, position });
    }
  }
  // MuseScore writes them in playback order already; a stable sort by time
  // keeps that order for events that share a timestamp.
  events.sort((left, right) => left.position - right.position);
  return { elements, events };
}

function parseAttributes(source: string): Map<string, number> {
  const attributes = new Map<string, number>();
  for (const match of source.matchAll(/([a-z]+)="([^"]*)"/gi)) {
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      attributes.set(match[1]!, value);
    }
  }
  return attributes;
}

/** Reads the page size from an exported SVG page's `viewBox`. */
export function parseSvgPageSize(svg: string): { width: number; height: number } | undefined {
  const viewBox = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg)?.[1];
  const parts = viewBox?.trim().split(/[\s,]+/).map(Number);
  if (!parts || parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  const [, , width, height] = parts as [number, number, number, number];
  return width > 0 && height > 0 ? { width: round1(width), height: round1(height) } : undefined;
}

/**
 * Builds the score view's timing map from MuseScore's position exports.
 *
 * Every measure-pass (`events`) carries the times and x positions of the note
 * onsets inside it (`b`, from `spos`), so the cursor can glide from note to
 * note and stand on each one exactly when it sounds -- the measure rectangle
 * alone could only say which bar is playing. A pass ends where the next one
 * starts. When the next pass is simply the following measure on the same line,
 * the last anchor is that measure's first note, so the cursor flows over the
 * bar line without a jump; otherwise it runs out to the bar line.
 */
export function buildScoreTiming(
  mpos: PositionsFile,
  spos: PositionsFile | undefined,
  pages: { width: number; height: number }[],
  marks: ScoreMarks = { sections: [], meters: [] }
): ScoreTiming {
  const scale = POSITION_UNITS_PER_SVG_UNIT;
  const maxId = Math.max(-1, ...mpos.elements.keys());
  const measures: (ScoreTimingMeasure | null)[] = Array.from({ length: maxId + 1 }, (_, id) => {
    const element = mpos.elements.get(id);
    return element
      ? {
          page: element.page,
          x: round1(element.x / scale),
          y: round1(element.y / scale),
          w: round1(element.sx / scale),
          h: round1(element.sy / scale)
        }
      : null;
  });

  const segments = (spos?.events ?? [])
    .map((event) => ({ time: event.position, element: spos!.elements.get(event.elid)! }))
    .sort((left, right) => left.time - right.time);

  const passes = mpos.events;
  const events: ScoreTimingEvent[] = [];
  let segmentIndex = 0;
  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index]!;
    const measure = measures[pass.elid];
    if (!measure) {
      continue;
    }
    const start = Math.round(pass.position);
    const previousLength = events.length ? events[events.length - 1]!.e - events[events.length - 1]!.t : 2000;
    const nextStart = passes[index + 1]?.position;
    let end = Math.round(nextStart ?? start + previousLength);

    const anchors: [number, number][] = [];
    while (segmentIndex < segments.length && segments[segmentIndex]!.time < start) {
      segmentIndex += 1;
    }
    for (let scan = segmentIndex; scan < segments.length && segments[scan]!.time < end; scan += 1) {
      const { time, element } = segments[scan]!;
      const x = (element.x + element.sx / 2) / scale;
      // Only the onsets drawn inside this measure's box on this page.
      if (element.page !== measure.page || x < measure.x - 1 || x > measure.x + measure.w + 1) {
        continue;
      }
      const roundedTime = Math.round(time);
      if (anchors.length && anchors[anchors.length - 1]![0] === roundedTime) {
        continue;
      }
      anchors.push([roundedTime, round1(x)]);
    }
    if (nextStart === undefined && anchors.length) {
      end = Math.max(end, anchors[anchors.length - 1]![0] + 1);
    }
    if (!anchors.length || anchors[0]![0] > start) {
      anchors.unshift([start, anchors[0]?.[1] ?? round1(measure.x + Math.min(measure.w * 0.15, 150))]);
    }

    const next = passes[index + 1];
    const nextMeasure = next ? measures[next.elid] : null;
    const flowsOn = Boolean(next && nextMeasure && next.elid === pass.elid + 1 &&
      nextMeasure.page === measure.page && Math.abs(nextMeasure.y - measure.y) < 1);
    const nextFirstX = flowsOn ? firstAnchorX(segments, next!.position, nextMeasure!) : undefined;
    anchors.push([end, nextFirstX ?? round1(measure.x + measure.w)]);

    events.push({ m: pass.elid, t: start, e: end, b: anchors });
  }

  return {
    version: 1,
    pages,
    measures,
    events,
    durationMs: events.length ? events[events.length - 1]!.e : 0,
    ...(marks.sections.length ? { sections: marks.sections.filter((section) => section.m < measures.length) } : {}),
    ...(marks.meters.length ? { meters: marks.meters.filter((meter) => meter.m < measures.length) } : {})
  };
}

export interface ScoreMarks {
  sections: ScoreTimingSection[];
  meters: ScoreTimingMeter[];
}

/**
 * Rehearsal marks ("A", "Chorus") and time signatures, by measure index, from
 * the top staff of the music -- MuseScore keeps system items like rehearsal
 * marks there. Measure N of that staff is the mpos's measure N (frames such as
 * `<VBox>` are not measures and are skipped).
 */
export function readScoreMarks(xml: string): ScoreMarks {
  const music = xml.slice(Math.max(0, xml.lastIndexOf("</Part>")));
  const start = music.indexOf("<Staff id=\"1\">");
  if (start < 0) {
    return { sections: [], meters: [] };
  }
  const next = music.indexOf("<Staff id=", start + 10);
  const staff = music.slice(start, next < 0 ? undefined : next);
  const sections: ScoreTimingSection[] = [];
  const meters: ScoreTimingMeter[] = [];
  const measures = staff.split(/<Measure\b/).slice(1);
  measures.forEach((measure, index) => {
    const body = measure.slice(0, Math.max(0, measure.indexOf("</Measure>")));
    const mark = /<RehearsalMark>[\s\S]*?<text>([\s\S]*?)<\/text>/.exec(body)?.[1];
    if (mark !== undefined) {
      const label = decodeXml(mark.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, 40);
      if (label) {
        sections.push({ m: index, label });
      }
    }
    const time = /<TimeSig>[\s\S]*?<sigN>(\d+)<\/sigN>[\s\S]*?<sigD>(\d+)<\/sigD>/.exec(body);
    if (time) {
      const n = Number(time[1]);
      const d = Number(time[2]);
      const last = meters[meters.length - 1];
      if (n > 0 && n <= 64 && d > 0 && d <= 64 && (last?.n !== n || last?.d !== d)) {
        meters.push({ m: index, n, d });
      }
    }
  });
  return { sections, meters };
}

function firstAnchorX(
  segments: { time: number; element: PositionElement }[],
  time: number,
  measure: ScoreTimingMeasure
): number | undefined {
  const scale = POSITION_UNITS_PER_SVG_UNIT;
  for (const segment of segments) {
    if (segment.time < time) {
      continue;
    }
    if (segment.time > time) {
      return undefined;
    }
    const x = (segment.element.x + segment.element.sx / 2) / scale;
    if (segment.element.page === measure.page && x >= measure.x - 1 && x <= measure.x + measure.w + 1) {
      return round1(x);
    }
  }
  return undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Content-addressed: the id changes whenever the score or the exporter does. */
export function scoreIdFor(content: Buffer): string {
  return createHash("sha256")
    .update(`bandcue-score-export-v${SCORE_EXPORTER_VERSION}\n`)
    .update(content)
    .digest("hex")
    .slice(0, 32);
}

export type StaffKind = "pitched" | "tablature" | "percussion";

/** An instrument of the score, as its .mscx describes it. */
export interface ScoreInstrument {
  /** The `<Part id>`. */
  id: string;
  name: string;
  /** Global staff numbers (the `<Staff id>` of the music), with their kind and note count. */
  staves: { number: number; kind: StaffKind; notes: number }[];
  /** Guitar, bass and friends: offered as notes and as tab. */
  fretted: boolean;
  strings: number;
  /** Hidden in the full score; its own voice shows it anyway. */
  hidden: boolean;
  /** Named like a drum kit but not on a percussion staff (some Guitar Pro imports): left as it is. */
  drumsByName: boolean;
}

/**
 * Reads the instruments of a score. MuseScore numbers staves by their order
 * across the `<Part>`s; the music of staff N follows as `<Staff id="N">`.
 */
export function readScoreInstruments(xml: string): ScoreInstrument[] {
  const music = xml.slice(xml.lastIndexOf("</Part>"));
  const notesOnStaff = (number: number) => {
    const start = music.indexOf(`<Staff id="${number}">`);
    if (start < 0) {
      return 0;
    }
    const next = music.indexOf("<Staff id=", start + 10);
    return (music.slice(start, next < 0 ? undefined : next).match(/<Note>/g) ?? []).length;
  };

  let staffNumber = 0;
  return [...xml.matchAll(/<Part id="([^"]+)">([\s\S]*?)<\/Part>/g)].map((match) => {
    const body = match[2] ?? "";
    const staves = [...body.matchAll(/<Staff>([\s\S]*?)<\/Staff>/g)].map((staff) => {
      staffNumber += 1;
      const group = /<StaffType group="([a-z]+)"/.exec(staff[1] ?? "")?.[1];
      const kind: StaffKind = group === "tablature" || group === "percussion" ? group : "pitched";
      return { number: staffNumber, kind, notes: notesOnStaff(staffNumber) };
    });
    const instrumentId = /<instrumentId>([^<]*)<\/instrumentId>/.exec(body)?.[1] ?? "";
    const instrumentTag = /<Instrument id="([^"]*)"/.exec(body)?.[1] ?? "";
    const strings = (/<StringData>([\s\S]*?)<\/StringData>/.exec(body)?.[1]?.match(/<string>/g) ?? []).length;
    const name = decodeXml(/<trackName>([^<]+)<\/trackName>/.exec(body)?.[1] ??
      /<longName>([^<]+)<\/longName>/.exec(body)?.[1] ?? `Instrument ${match[1]}`).trim().slice(0, 80);
    const percussion = staves.some((staff) => staff.kind === "percussion");
    const drumsByName = !percussion && /drum|schlag|percussion/i.test(name);
    // Imports do not always say what an instrument is: a "Guitar" can arrive as
    // a piano on a tab staff. A fretted instrument is one that says so, or one
    // named like it that has strings or a tab staff.
    const looksFretted = /^pluck\./.test(instrumentId) ||
      /guitar|gitarre|bass|ukulele|banjo|mandolin/i.test(`${instrumentTag} ${name}`);
    return {
      id: match[1]!,
      name,
      staves,
      fretted: !percussion && !drumsByName && looksFretted &&
        (strings > 0 || staves.some((staff) => staff.kind === "tablature")),
      strings: strings || (/bass/i.test(`${instrumentId} ${name}`) ? 4 : 6),
      hidden: /^\s*<show>0<\/show>/m.test(body),
      drumsByName
    };
  });
}

export interface VoicePlan {
  /** File stem: `score`, `part-<n>`, or `part-<n>-notes` / `part-<n>-tab`. */
  stem: string;
  name: string;
  /** Voices of one instrument share this; the full score's is `score`. */
  instrument: string;
  notation?: "notes" | "tab";
  /** Turns the full score's .mscx into this voice's. */
  transform: (xml: string) => string;
}

/**
 * What to export: the full score, then every visible instrument on its own --
 * guitars and basses twice, as notes and as tab; everything else as notes
 * (Guitar Pro imports often keep even vocals on a tab staff).
 *
 * Each voice is the full score with every other instrument hidden, not a
 * MuseScore "part": parts that MuseScore generates from the command line
 * (`--score-parts`) came out with doubled measures and different tempos for
 * some scores, so their timing no longer matched what MuseScore plays.
 */
export function planVoices(instruments: ScoreInstrument[]): VoicePlan[] {
  const plans: VoicePlan[] = [{ stem: "score", name: "Full score", instrument: "score", transform: (xml) => xml }];
  // An instrument without a single note (an empty drum staff, say) is no voice.
  const playing = instruments.filter((instrument) => instrument.staves.some((staff) => staff.notes > 0));
  if (playing.length < 2 && !playing.some((instrument) => instrument.fretted)) {
    return plans;
  }
  for (const instrument of playing) {
    const stem = `part-${instrument.id}`;
    const isDrums = instrument.drumsByName || instrument.staves.every((staff) => staff.kind === "percussion");
    const notations: ("notes" | "tab" | undefined)[] = instrument.fretted ? ["notes", "tab"] : [isDrums ? undefined : "notes"];
    for (const notation of notations) {
      plans.push({
        stem: instrument.fretted ? `${stem}-${notation}` : stem,
        name: instrument.name,
        instrument: stem,
        notation: instrument.fretted ? notation : undefined,
        transform: (xml) => soloInstrument(xml, instrument, notation)
      });
    }
  }
  return plans;
}

/** The score with only `instrument` shown, its staves set to `notation`. */
export function soloInstrument(xml: string, instrument: ScoreInstrument, notation: "notes" | "tab" | undefined): string {
  const target: StaffKind = notation === "tab" ? "tablature" : "pitched";
  const keep = notation ? stavesFor(instrument, target) : undefined;
  const converted = instrument.staves.filter((_, index) => keep?.get(index) === "convert").map((staff) => staff.number);
  const soloed = xml.replace(/<Part id="([^"]+)">([\s\S]*?)<\/Part>/g, (part, id: string) => {
    if (id !== instrument.id) {
      return /<show>0<\/show>/.test(part) ? part : part.replace(/<Part id="[^"]+">/, (open) => `${open}\n      <show>0</show>`);
    }
    // Hidden in the full score, but this voice is the instrument itself.
    const shown = part.replace(/\n?[ \t]*<show>0<\/show>/, "");
    if (!keep) {
      return shown;
    }
    let index = 0;
    return shown.replace(/<Staff>([\s\S]*?)<\/Staff>/g, (staff) => {
      const action = keep.get(index);
      index += 1;
      if (action === "show") {
        return staff;
      }
      if (action === "convert") {
        return convertStaff(staff, notation === "tab" ? "tablature" : "pitched", instrument.strings);
      }
      return staff.replace("<Staff>", "<Staff>\n        <isStaffVisible>0</isStaffVisible>");
    });
  });
  if (!converted.length) {
    return soloed;
  }
  // Clefs live in the music, not in the staff definition: a converted staff
  // gets the clef of its new kind -- TAB, or the octave clef guitars and
  // basses are written in.
  const clef = target === "tablature" ? "TAB" : /bass/i.test(instrument.name) ? "F8_vb" : "G8_vb";
  const musicStart = soloed.lastIndexOf("</Part>");
  const music = soloed.slice(musicStart).replace(/<Staff id="(\d+)">[\s\S]*?(?=<Staff id="|<\/Score>)/g, (staff, number: string) =>
    converted.includes(Number(number))
      ? staff.replace(/<(concertClefType|transposingClefType)>([^<]*)<\/\1>/g, (tag, name: string, type: string) =>
        target === "tablature" || /^TAB/.test(type) ? `<${name}>${clef}</${name}>` : tag)
      : staff);
  return soloed.slice(0, musicStart) + music;
}

/**
 * Per staff of the instrument (by position): show it, convert it, or hide it.
 * A staff of the wanted kind that has notes is shown as it is; otherwise the
 * staff with the notes is converted (MuseScore works out frets from pitches and
 * pitches from frets). Everything else -- the other kind, empty staves -- hides.
 */
function stavesFor(instrument: ScoreInstrument, wanted: StaffKind): Map<number, "show" | "convert" | "hide"> {
  const actions = new Map<number, "show" | "convert" | "hide">();
  const ready = instrument.staves.filter((staff) => staff.kind === wanted && staff.notes > 0);
  if (ready.length) {
    instrument.staves.forEach((staff, index) => actions.set(index, ready.includes(staff) ? "show" : "hide"));
    return actions;
  }
  const withNotes = instrument.staves.filter((staff) => staff.kind !== "percussion" && staff.notes > 0);
  const source = withNotes.length ? withNotes : instrument.staves.filter((staff) => staff.kind !== "percussion").slice(0, 1);
  instrument.staves.forEach((staff, index) => actions.set(index, source.includes(staff)
    ? staff.kind === wanted ? "show" : "convert"
    : "hide"));
  return actions;
}

function convertStaff(staff: string, kind: StaffKind, strings: number): string {
  const staffType = kind === "tablature"
    ? `<StaffType group="tablature">\n          <name>tab${strings}StrCommon</name>\n          <lines>${strings}</lines>\n          </StaffType>`
    : "<StaffType group=\"pitched\">\n          <name>stdNormal</name>\n          </StaffType>";
  const converted = /<StaffType\b[\s\S]*?<\/StaffType>/.test(staff)
    ? staff.replace(/<StaffType\b[\s\S]*?<\/StaffType>/, staffType)
    : staff.replace("<Staff>", `<Staff>\n        ${staffType}`);
  // A tab clef has no place on a staff of notes, and the reverse.
  return converted.replace(/\s*<defaultClef>[^<]*<\/defaultClef>/, "");
}

/** Multimeasure rests would fold measures together that the cursor counts one by one. */
export function withoutMultimeasureRests(text: string): string {
  return text.replace(/<createMultiMeasureRests>1<\/createMultiMeasureRests>/g, "<createMultiMeasureRests>0</createMultiMeasureRests>");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * The `-j` conversion job: SVG pages, measure and segment positions for every
 * voice. MuseScore numbers the SVG pages itself (`score-1.svg`, `score-2.svg`, …).
 */
export function buildExportJob(stems: string[]): { in: string; out: string[] }[] {
  return stems.map((stem) => ({ in: `${stem}.mscz`, out: [`${stem}.svg`, `${stem}.mpos`, `${stem}.spos`] }));
}

export interface MuseScoreRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type MuseScoreRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<MuseScoreRunResult>;

export const runMuseScore: MuseScoreRunner = (executable, args, options) => new Promise((resolvePromise) => {
  const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const timer = setTimeout(() => child.kill(), options.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("error", (error) => {
    clearTimeout(timer);
    resolvePromise({ code: -1, stdout: "", stderr: error.message });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolvePromise({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    });
  });
});

/** Finds MuseScore's command-line capable executable on Windows. */
export async function findMuseScoreExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const configured = env.BANDCUE_MUSESCORE_EXE?.trim();
  if (configured) {
    return existsSync(configured) ? configured : undefined;
  }
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]
    .filter((root): root is string => Boolean(root));
  for (const root of roots) {
    for (const folder of ["MuseScore 4", "MuseScore Studio 4", "MuseScore Studio"]) {
      for (const exe of ["MuseScore4.exe", "MuseScoreStudio.exe"]) {
        const candidate = join(root, folder, "bin", exe);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  // The registry's App Paths entry covers installs in unusual places.
  for (const exe of ["MuseScore4.exe", "MuseScoreStudio.exe"]) {
    for (const hive of ["HKCU", "HKLM"]) {
      const query = await runMuseScore("reg.exe", [
        "query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"
      ], { cwd: tmpdir(), timeoutMs: 5_000 });
      const path = /REG_SZ\s+(.+\.exe)/i.exec(query.stdout)?.[1]?.trim().replace(/^"|"$/g, "");
      if (path && existsSync(path)) {
        return path;
      }
    }
  }
  return undefined;
}

export interface ScoreExportSource {
  absolutePath: string;
  relativePath: string;
  title: string;
  /**
   * Export even if MuseScore calls the score corrupted (`-f`), as its GUI
   * would after "open anyway". For converted Guitar Pro imports: MuseScore's
   * importer can leave a measure it then refuses to load ("Incomplete
   * measure"), although it plays it fine.
   */
  force?: boolean;
}

export interface ExportedScore {
  scoreId: string;
  /** Directory holding manifest.json and every file it lists. */
  dir: string;
  manifest: ScoreManifest;
  /** Every file to upload, manifest.json last. */
  files: string[];
}

export interface ScoreExportOptions {
  cacheDir: string;
  executable: string;
  run?: MuseScoreRunner;
  now?: () => number;
}

/** Lists the files of an export, manifest last: its arrival marks the upload complete. */
export function exportFiles(manifest: ScoreManifest): string[] {
  return [...manifest.parts.flatMap((part) => [...part.pages, part.timing]), "manifest.json"];
}

/** Reads a previous export of this exact score from the cache, if there is one. */
export async function readCachedExport(cacheDir: string, scoreId: string): Promise<ExportedScore | undefined> {
  const dir = join(cacheDir, scoreId);
  try {
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ScoreManifest;
    if (manifest.scoreId !== scoreId || !Array.isArray(manifest.parts)) {
      return undefined;
    }
    return { scoreId, dir, manifest, files: exportFiles(manifest) };
  } catch {
    return undefined;
  }
}

let cachedMuseScoreVersion: string | undefined;

export async function exportScore(source: ScoreExportSource, options: ScoreExportOptions): Promise<ExportedScore> {
  const run = options.run ?? runMuseScore;
  const content = await readFile(source.absolutePath);
  const scoreId = scoreIdFor(content);
  const cached = await readCachedExport(options.cacheDir, scoreId);
  if (cached) {
    return cached;
  }

  const work = await mkdtemp(join(tmpdir(), "bandcue-export-"));
  try {
    const paged = forcePageLayout(content) ?? content;
    const scoreEntry = readZipEntries(paged).find((entry) => isScoreFile(entry.name));
    if (!scoreEntry) {
      throw new Error("No score inside the .mscz.");
    }
    const scoreXml = entryContent(scoreEntry).toString("utf8");
    const voices = planVoices(readScoreInstruments(scoreXml));
    const marks = readScoreMarks(scoreXml);
    for (const voice of voices) {
      const copy = rewriteZipText(paged, (name) => isScoreFile(name) || name === "score_style.mss",
        (text) => withoutMultimeasureRests(voice.stem === "score" ? text : voice.transform(text)));
      await writeFile(join(work, `${voice.stem}.mscz`), copy ?? paged);
    }

    await writeFile(join(work, "job.json"), JSON.stringify(buildExportJob(voices.map((voice) => voice.stem))));
    const jobRun = await run(options.executable, [...(source.force ? ["-f"] : []), "-j", "job.json"], {
      cwd: work,
      timeoutMs: MUSESCORE_RUN_TIMEOUT_MS
    });
    if (!existsSync(join(work, "score.mpos"))) {
      throw new Error(`MuseScore did not export the score (exit ${jobRun.code}): ${lastLine(jobRun.stderr)}`);
    }

    if (cachedMuseScoreVersion === undefined) {
      const versionRun = await run(options.executable, ["--version"], { cwd: work, timeoutMs: 30_000 });
      cachedMuseScoreVersion = lastLine(versionRun.stdout) || "";
    }

    const staging = join(options.cacheDir, `${scoreId}.partial`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const workFiles = await readdir(work);
    const manifestParts: ScoreManifestPart[] = [];
    for (const voice of voices) {
      const part = await collectVoice(work, workFiles, staging, voice.stem, voice.name, marks);
      if (part) {
        manifestParts.push({ ...part, instrument: voice.instrument, notation: voice.notation });
      }
    }
    if (!manifestParts.length) {
      throw new Error("MuseScore exported no readable pages.");
    }

    const manifest: ScoreManifest = {
      version: 1,
      scoreId,
      title: source.title,
      relativePath: source.relativePath,
      museScoreVersion: cachedMuseScoreVersion || undefined,
      exportedAt: (options.now ?? Date.now)(),
      parts: manifestParts
    };
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest));
    const dir = join(options.cacheDir, scoreId);
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
    return { scoreId, dir, manifest, files: exportFiles(manifest) };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function collectVoice(
  work: string,
  workFiles: string[],
  target: string,
  stem: string,
  name: string,
  marks: ScoreMarks
): Promise<ScoreManifestPart | undefined> {
  const pagePattern = new RegExp(`^${stem}-(\\d+)\\.svg$`);
  const pageFiles = workFiles
    .map((file) => ({ file, page: Number(pagePattern.exec(file)?.[1]) }))
    .filter((entry) => Number.isInteger(entry.page) && entry.page > 0)
    .sort((left, right) => left.page - right.page);
  if (!pageFiles.length || !workFiles.includes(`${stem}.mpos`)) {
    return undefined;
  }

  const pages: string[] = [];
  const sizes: { width: number; height: number }[] = [];
  for (const { file, page } of pageFiles) {
    const svg = await readFile(join(work, file), "utf8");
    const size = parseSvgPageSize(svg.slice(0, 2000));
    if (!size) {
      return undefined;
    }
    const published = `${stem}-${page}.svg`;
    await writeFile(join(target, published), svg);
    pages.push(published);
    sizes.push(size);
  }

  const mpos = parsePositionsXml(await readFile(join(work, `${stem}.mpos`), "utf8"));
  const spos = workFiles.includes(`${stem}.spos`)
    ? parsePositionsXml(await readFile(join(work, `${stem}.spos`), "utf8"))
    : undefined;
  const timing = buildScoreTiming(mpos, spos, sizes, marks);
  const timingFile = `${stem}.timing.json`;
  await writeFile(join(target, timingFile), JSON.stringify(timing));

  return {
    id: stem,
    name,
    pages,
    timing: timingFile,
    measureCount: timing.measures.length,
    durationMs: timing.durationMs
  };
}

function isScoreFile(name: string): boolean {
  return /\.mscx$/i.test(name) && !name.includes("/");
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.trim().slice(0, 200) ?? "";
}

export interface ScoreExportJob {
  songId: string;
  source: ScoreExportSource;
  /** Set when the score is a converted Songsterr import. */
  importKey?: string;
  importId?: string;
}

interface TrackedScore {
  source: ScoreExportSource;
  fileStamp: string;
  state: ScoreExportReport["status"];
  scoreId?: string;
  detail?: string;
  exported?: ExportedScore;
  verifiedAt?: number;
  failedAt?: number;
}

export interface ScoreExportQueueOptions {
  exportScore: (source: ScoreExportSource) => Promise<ExportedScore>;
  /** Uploads (or confirms) the export on the coordinator. */
  publish: (exported: ExportedScore) => Promise<void>;
  /** Exports wait while this says so, e.g. during playback. */
  isPaused?: () => boolean;
  onChange?: () => void;
  now?: () => number;
  log?: (message: string) => void;
  /** How long a published export is trusted before it is checked again. */
  reverifyMs?: number;
  /** How long a failed export waits before it is retried. */
  retryMs?: number;
}

/**
 * Keeps the coordinator supplied with the exports of tonight's songs. Jobs run
 * one at a time, the current song first; a score whose file changed is exported
 * again, and a published export is re-confirmed now and then in case the
 * coordinator restarted with an empty store.
 */
export class ScoreExportQueue {
  private readonly tracked = new Map<string, TrackedScore>();
  private songs: ScoreExportJob[] = [];
  private priorityPath?: string;
  private running = false;

  constructor(private readonly options: ScoreExportQueueOptions) {}

  /** Replaces the wanted songs; `priorityPath` is the current song's score. */
  sync(songs: ScoreExportJob[], priorityPath?: string): void {
    this.songs = songs;
    this.priorityPath = priorityPath;
    void this.pump();
  }

  /** Forgets every publish confirmation, e.g. after connecting to a coordinator. */
  invalidatePublished(): void {
    for (const item of this.tracked.values()) {
      if (item.state === "ready") {
        item.verifiedAt = undefined;
      }
    }
    void this.pump();
  }

  reports(): ScoreExportReport[] {
    return this.songs.map(({ songId, source, importKey, importId }) => {
      const item = this.tracked.get(source.absolutePath);
      return {
        songId,
        relativePath: source.relativePath,
        status: item?.state ?? "queued",
        scoreId: item?.state === "ready" ? item.scoreId : undefined,
        detail: item?.detail,
        ...(importKey ? { importKey, importId } : {})
      };
    });
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (;;) {
        if (this.options.isPaused?.()) {
          return;
        }
        const next = await this.nextJob();
        if (!next) {
          return;
        }
        await this.process(next.item, next.fileStamp);
      }
    } catch (error) {
      // An export must never take the helper (and with it playback) down.
      this.options.log?.(`Score view export queue stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Lets a paused queue continue (call when the pause condition ends). */
  resume(): void {
    void this.pump();
  }

  private async nextJob(): Promise<{ item: TrackedScore; fileStamp: string } | undefined> {
    const now = (this.options.now ?? Date.now)();
    const reverifyMs = this.options.reverifyMs ?? 60_000;
    const retryMs = this.options.retryMs ?? 120_000;
    const ordered = [...this.songs].sort((left, right) =>
      Number(right.source.relativePath === this.priorityPath) - Number(left.source.relativePath === this.priorityPath));
    for (const { source } of ordered) {
      const fileStamp = await stampFor(source.absolutePath);
      let item = this.tracked.get(source.absolutePath);
      if (!item || item.fileStamp !== fileStamp) {
        item = { source, fileStamp, state: "queued" };
        this.tracked.set(source.absolutePath, item);
        this.options.onChange?.();
      }
      item.source = source;
      if (item.state === "queued" ||
          (item.state === "ready" && (item.verifiedAt === undefined || now - item.verifiedAt > reverifyMs)) ||
          (item.state === "failed" && now - (item.failedAt ?? 0) > retryMs)) {
        return { item, fileStamp };
      }
    }
    return undefined;
  }

  private async process(item: TrackedScore, fileStamp: string): Promise<void> {
    const log = this.options.log ?? (() => undefined);
    const wasReady = item.state === "ready" && item.exported;
    try {
      if (!wasReady) {
        item.state = "exporting";
        item.detail = undefined;
        this.options.onChange?.();
        const started = Date.now();
        item.exported = await this.options.exportScore(item.source);
        item.scoreId = item.exported.scoreId;
        log(`Exported score view for ${item.source.relativePath} in ${Date.now() - started} ms (${item.exported.manifest.parts.length} voice${item.exported.manifest.parts.length === 1 ? "" : "s"}).`);
      }
      await this.options.publish(item.exported!);
      if (item.fileStamp !== fileStamp) {
        return;
      }
      item.state = "ready";
      item.detail = undefined;
      item.verifiedAt = (this.options.now ?? Date.now)();
    } catch (error) {
      item.state = "failed";
      item.failedAt = (this.options.now ?? Date.now)();
      item.detail = trimDetail(error instanceof Error ? error.message : String(error));
      log(`Score view export failed for ${item.source.relativePath}: ${item.detail}`);
    }
    this.options.onChange?.();
  }
}

async function stampFor(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    return `${stats.size}:${Math.round(stats.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

function trimDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}
