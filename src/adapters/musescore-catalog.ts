import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import type { SetlistSong, SongCatalogEntry, SongCatalogMatch } from "../shared/protocol.js";
import { appliesToMuseScore, museScoreReference } from "../shared/song-sources.js";
import { entryContent, readZipEntries } from "./mscz-page-layout.js";

export interface LocalScoreCatalogEntry extends SongCatalogEntry {
  absolutePath: string;
}

export interface LocalScoreCatalog {
  entries: LocalScoreCatalogEntry[];
  rootCount: number;
  scannedAt: number;
  detail: string;
}

export interface CatalogScanOptions {
  recursive?: boolean;
  maxEntries?: number;
}

const SCORE_EXTENSIONS = new Set([".mscz", ".mscx"]);

export function scanMuseScoreCatalog(
  roots: string[],
  options: CatalogScanOptions = {}
): LocalScoreCatalog {
  const uniqueRoots = [...new Set(roots.map((root) => root.trim()).filter(Boolean))]
    .map((root) => resolve(root));
  const recursive = options.recursive ?? true;
  const maxEntries = options.maxEntries ?? 5000;
  const entries: LocalScoreCatalogEntry[] = [];
  const errors: string[] = [];

  for (const root of uniqueRoots) {
    if (entries.length >= maxEntries) {
      break;
    }

    try {
      scanRoot(root, root, recursive, maxEntries, entries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${basename(root) || root}: ${message}`);
    }
  }

  return {
    entries,
    rootCount: uniqueRoots.length,
    scannedAt: Date.now(),
    detail: catalogDetail(entries.length, uniqueRoots.length, errors)
  };
}

/**
 * The MuseScore version that saved a score (`<museScore version="4.70">` → 4.7),
 * or 0 when the file cannot be read.
 */
export type ScoreFormatVersionReader = (entry: LocalScoreCatalogEntry) => number;

export function matchMuseScoreSong(
  song: SetlistSong | undefined,
  entries: LocalScoreCatalogEntry[],
  formatVersionOf: ScoreFormatVersionReader = readScoreFormatVersion
): SongCatalogMatch {
  if (!appliesToMuseScore(song)) {
    return {
      status: "not-applicable",
      detail: "No current MuseScore song is selected."
    };
  }

  const reference = museScoreReference(song);
  const expectedSource = normalizeIdentity(reference);
  const expectedTitle = normalizeIdentity(song?.title ?? "");
  const sourceLooksLikePath = Boolean(reference && /[\\/]/.test(reference));
  const sourceMatches = expectedSource
    ? entries.filter((entry) => {
      const relativePath = normalizeIdentity(entry.relativePath);
      const title = normalizeIdentity(entry.title);
      const extensionlessPath = normalizeIdentity(stripScoreExtension(entry.relativePath));
      return (
        relativePath === expectedSource ||
        extensionlessPath === expectedSource ||
        (!sourceLooksLikePath && title === expectedSource)
      );
    })
    : [];
  const matches = sourceMatches.length || expectedSource
    ? sourceMatches
    : entries.filter((entry) => {
    const relativePath = normalizeIdentity(entry.relativePath);
    const title = normalizeIdentity(entry.title);
    const extensionlessPath = normalizeIdentity(stripScoreExtension(entry.relativePath));

    return Boolean(expectedTitle && (title === expectedTitle || extensionlessPath === expectedTitle));
  });

  if (matches.length === 1) {
    return {
      status: "matched",
      count: 1,
      title: matches[0]?.title,
      relativePath: matches[0]?.relativePath,
      detail: `Matched ${matches[0]?.relativePath}`
    };
  }

  // The same song in several folders is usually a MuseScore 3 original next to
  // its MuseScore 4 re-save: the score saved by the newest MuseScore is the one
  // the band keeps working on. Only a clear winner counts.
  const newest = matches.length > 1 ? newestFormat(matches, formatVersionOf) : undefined;
  if (newest) {
    return {
      status: "matched",
      count: 1,
      title: newest.title,
      relativePath: newest.relativePath,
      detail: `Matched ${newest.relativePath} (saved by the newest MuseScore of ${matches.length} matching files)`
    };
  }

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      count: matches.length,
      detail: `Found ${matches.length} matching MuseScore files; refine the setlist source path.`
    };
  }

  return {
    status: "missing",
    count: 0,
    detail: `No local MuseScore file matched "${reference || song?.title}".`
  };
}

export function matchedCatalogEntry(
  match: SongCatalogMatch,
  entries: LocalScoreCatalogEntry[]
): LocalScoreCatalogEntry | undefined {
  if (match.status !== "matched" || !match.relativePath) {
    return undefined;
  }

  return entries.find((entry) => entry.relativePath === match.relativePath);
}

export function publicCatalogEntries(entries: LocalScoreCatalogEntry[]): SongCatalogEntry[] {
  return entries.map(({ title, relativePath, sourceId }) => ({
    title,
    relativePath,
    sourceId
  }));
}

function newestFormat(
  matches: LocalScoreCatalogEntry[],
  formatVersionOf: ScoreFormatVersionReader
): LocalScoreCatalogEntry | undefined {
  const versions = matches.map((entry) => ({ entry, version: formatVersionOf(entry) }));
  const best = Math.max(...versions.map(({ version }) => version));
  const winners = versions.filter(({ version }) => version === best);
  return best > 0 && winners.length === 1 ? winners[0]?.entry : undefined;
}

const formatVersionCache = new Map<string, { stamp: string; version: number }>();

/** Reads the `<museScore version>` of a .mscz/.mscx, cached per file size and time. */
export function readScoreFormatVersion(entry: LocalScoreCatalogEntry): number {
  try {
    const stats = statSync(entry.absolutePath);
    const stamp = `${stats.size}:${stats.mtimeMs}`;
    const cached = formatVersionCache.get(entry.absolutePath);
    if (cached?.stamp === stamp) {
      return cached.version;
    }
    const content = readFileSync(entry.absolutePath);
    const xml = extname(entry.absolutePath).toLowerCase() === ".mscx"
      ? content.subarray(0, 4096).toString("utf8")
      : (() => {
        const score = readZipEntries(content).find((item) => /\.mscx$/i.test(item.name) && !item.name.includes("/"));
        return score ? entryContent(score).subarray(0, 4096).toString("utf8") : "";
      })();
    const version = Number(/<museScore\s+version="(\d+(?:\.\d+)?)"/.exec(xml)?.[1] ?? 0) || 0;
    formatVersionCache.set(entry.absolutePath, { stamp, version });
    return version;
  } catch {
    return 0;
  }
}

function scanRoot(
  root: string,
  current: string,
  recursive: boolean,
  maxEntries: number,
  entries: LocalScoreCatalogEntry[]
): void {
  for (const item of readdirSync(current, { withFileTypes: true })) {
    if (entries.length >= maxEntries) {
      return;
    }

    const absolutePath = resolve(current, item.name);
    if (item.isDirectory()) {
      if (recursive) {
        scanRoot(root, absolutePath, recursive, maxEntries, entries);
      }
      continue;
    }

    if (!item.isFile() || !SCORE_EXTENSIONS.has(extname(item.name).toLowerCase())) {
      continue;
    }

    const stats = statSync(absolutePath);
    if (!stats.isFile()) {
      continue;
    }

    const relativePath = toSafeRelativePath(relative(root, absolutePath));
    if (!relativePath) {
      continue;
    }

    entries.push({
      title: stripScoreExtension(basename(item.name)),
      relativePath,
      absolutePath,
      sourceId: normalizeIdentity(relativePath)
    });
  }
}

function catalogDetail(entryCount: number, rootCount: number, errors: string[]): string {
  const base = rootCount
    ? `Published ${entryCount} MuseScore score${entryCount === 1 ? "" : "s"} from ${rootCount} folder${rootCount === 1 ? "" : "s"}.`
    : "No MuseScore score folders are configured.";

  return errors.length ? `${base} ${errors.slice(0, 3).join("; ")}` : base;
}

function stripScoreExtension(value: string): string {
  return value.replace(/\.(mscz|mscx)$/i, "");
}

function toSafeRelativePath(value: string): string {
  const normalized = value.split(sep).join("/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.includes("../")) {
    return "";
  }

  return normalized;
}

function normalizeIdentity(value: string): string {
  return stripScoreExtension(value)
    .replace(/\\/g, "/")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
