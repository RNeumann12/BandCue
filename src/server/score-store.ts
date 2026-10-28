import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Holds the score-view exports the MuseScore helper uploads, so every companion
// can fetch them from the coordinator. A score's files live under its scoreId,
// which is a hash of the score's contents: the files never change under an id,
// so they can be cached by the browsers forever, and a new version of a score
// simply arrives as a new id. When the store outgrows its budget, the scores
// used least recently go first. A Guitar Pro file imported from Songsterr is
// kept the same way, as `source.gp` under its own content hash. Plain fs only --
// this has to run on the Pi's Node 18.

export const SCORE_ID_PATTERN = /^[a-f0-9]{16,64}$/;
const FILE_NAME_PATTERN = /^(manifest\.json|source\.gp|[a-z0-9][a-z0-9_-]{0,60}\.timing\.json|[a-z0-9][a-z0-9_-]{0,60}\.svg)$/;
const GZIP_MAGIC = [0x1f, 0x8b];
export const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface ScoreStoreOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

export interface StoredScoreFile {
  path: string;
  /** The bytes on disk are gzip, to be sent with `Content-Encoding: gzip`. */
  gzip: boolean;
  size: number;
  contentType: string;
}

export class ScoreStoreError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function isValidScoreFileName(file: string): boolean {
  return FILE_NAME_PATTERN.test(file);
}

export class ScoreStore {
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  /** Last read or write per score, for evicting the least recently used. */
  private readonly lastUsed = new Map<string, number>();

  constructor(private readonly root: string, options: ScoreStoreOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.now = options.now ?? Date.now;
  }

  get maxUploadBytes(): number {
    return this.maxFileBytes;
  }

  /** Whether a complete export (its manifest arrives last) is stored. */
  has(scoreId: string): boolean {
    return SCORE_ID_PATTERN.test(scoreId) &&
      (existsSync(join(this.root, scoreId, "manifest.json")) || existsSync(join(this.root, scoreId, "manifest.json.gz")));
  }

  get(scoreId: string, file: string): StoredScoreFile | undefined {
    if (!SCORE_ID_PATTERN.test(scoreId) || !isValidScoreFileName(file)) {
      return undefined;
    }
    for (const gzip of [true, false]) {
      const path = join(this.root, scoreId, gzip ? `${file}.gz` : file);
      try {
        const stats = statSync(path);
        if (stats.isFile()) {
          this.lastUsed.set(scoreId, this.now());
          return { path, gzip, size: stats.size, contentType: contentTypeFor(file) };
        }
      } catch {
        // Try the other encoding, then give up.
      }
    }
    return undefined;
  }

  open(file: StoredScoreFile): NodeJS.ReadableStream {
    return createReadStream(file.path);
  }

  async put(scoreId: string, file: string, body: Buffer, gzip: boolean): Promise<void> {
    if (!SCORE_ID_PATTERN.test(scoreId)) {
      throw new ScoreStoreError(400, "Invalid score id.");
    }
    if (!isValidScoreFileName(file)) {
      throw new ScoreStoreError(400, "File name not allowed.");
    }
    if (body.length > this.maxFileBytes) {
      throw new ScoreStoreError(413, "File too large.");
    }
    if (gzip && (body[0] !== GZIP_MAGIC[0] || body[1] !== GZIP_MAGIC[1])) {
      throw new ScoreStoreError(400, "Body is not gzip.");
    }

    const dir = join(this.root, scoreId);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, gzip ? `${file}.gz` : file);
    const temporary = `${target}.${process.pid}.${this.now()}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, target);
    // Only one encoding of a file may exist, or a re-upload would leave the
    // stale one to be served.
    await rm(join(dir, gzip ? file : `${file}.gz`), { force: true });
    this.lastUsed.set(scoreId, this.now());
    this.evict(scoreId);
  }

  /** Drops whole scores, least recently used first, until the store fits. */
  private evict(keep: string): void {
    const scores = this.listScores();
    let total = scores.reduce((sum, score) => sum + score.bytes, 0);
    const candidates = scores
      .filter((score) => score.id !== keep)
      .sort((left, right) => left.usedAt - right.usedAt);
    for (const score of candidates) {
      if (total <= this.maxTotalBytes) {
        break;
      }
      rmSync(join(this.root, score.id), { recursive: true, force: true });
      this.lastUsed.delete(score.id);
      total -= score.bytes;
    }
  }

  private listScores(): { id: string; bytes: number; usedAt: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    return names.filter((name) => SCORE_ID_PATTERN.test(name)).map((id) => {
      const dir = join(this.root, id);
      let bytes = 0;
      let modifiedAt = 0;
      try {
        for (const file of readdirSync(dir)) {
          const stats = statSync(join(dir, file));
          bytes += stats.size;
          modifiedAt = Math.max(modifiedAt, stats.mtimeMs);
        }
      } catch {
        // A directory that vanished counts as empty.
      }
      return { id, bytes, usedAt: this.lastUsed.get(id) ?? modifiedAt };
    });
  }
}

function contentTypeFor(file: string): string {
  if (file.endsWith(".gp")) {
    return "application/octet-stream";
  }
  return file.endsWith(".svg") ? "image/svg+xml" : "application/json; charset=utf-8";
}

/** `.bandcue-scores` next to the room's state file. */
export function scoreStoreDirFor(identityFile: string): string {
  return join(dirname(identityFile), ".bandcue-scores");
}
