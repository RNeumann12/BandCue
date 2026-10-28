import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ScoreStore, ScoreStoreError, isValidScoreFileName, scoreStoreDirFor } from "./score-store.js";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);

function store(options: ConstructorParameters<typeof ScoreStore>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "bandcue-store-"));
  return { root, store: new ScoreStore(root, options) };
}

describe("ScoreStore", () => {
  it("stores gzip uploads as they came and reports a score complete once its manifest is in", async () => {
    const { store: scores } = store();
    await scores.put(ID_A, "score-1.svg", gzipSync("<svg/>"), true);
    expect(scores.has(ID_A)).toBe(false);
    await scores.put(ID_A, "manifest.json", Buffer.from("{}"), false);
    expect(scores.has(ID_A)).toBe(true);

    const page = scores.get(ID_A, "score-1.svg")!;
    expect(page).toMatchObject({ gzip: true, contentType: "image/svg+xml" });
    expect(readFileSync(page.path)).toEqual(gzipSync("<svg/>"));
    expect(scores.get(ID_A, "manifest.json")).toMatchObject({ gzip: false });
  });

  it("allows only the files an export consists of", () => {
    for (const name of ["manifest.json", "score.timing.json", "part-2.timing.json", "score-1.svg", "part-12-3.svg"]) {
      expect(isValidScoreFileName(name)).toBe(true);
    }
    for (const name of ["../room.json", "..", "index.html", "score.js", "a/b.svg", ".svg", "Score-1.svg", "x.svg.gz"]) {
      expect(isValidScoreFileName(name)).toBe(false);
    }
  });

  it("refuses path traversal, odd ids, oversized files and fake gzip", async () => {
    const { store: scores, root } = store({ maxFileBytes: 10 });
    await expect(scores.put("../../etc", "manifest.json", Buffer.from("{}"), false)).rejects.toBeInstanceOf(ScoreStoreError);
    await expect(scores.put(ID_A, "../manifest.json", Buffer.from("{}"), false)).rejects.toMatchObject({ statusCode: 400 });
    await expect(scores.put(ID_A, "score-1.svg", Buffer.alloc(11), false)).rejects.toMatchObject({ statusCode: 413 });
    await expect(scores.put(ID_A, "score-1.svg", Buffer.from("plain"), true)).rejects.toMatchObject({ statusCode: 400 });
    expect(scores.get("..", "manifest.json")).toBeUndefined();
    expect(scores.get(ID_A, "..%2Fx")).toBeUndefined();
    expect(existsSync(join(root, ID_A))).toBe(false);
  });

  it("replaces a file's other encoding on re-upload", async () => {
    const { store: scores } = store();
    await scores.put(ID_A, "score.timing.json", Buffer.from("{\"old\":1}"), false);
    await scores.put(ID_A, "score.timing.json", gzipSync("{\"new\":1}"), true);
    expect(scores.get(ID_A, "score.timing.json")).toMatchObject({ gzip: true });
  });

  it("evicts the least recently used scores beyond the total budget, never the one just written", async () => {
    let now = 1;
    const { store: scores } = store({ maxTotalBytes: 2500, now: () => now });
    await scores.put(ID_A, "manifest.json", Buffer.alloc(1000), false);
    now = 2;
    await scores.put(ID_B, "manifest.json", Buffer.alloc(1000), false);
    now = 3;
    scores.get(ID_A, "manifest.json");
    now = 4;
    await scores.put(ID_C, "manifest.json", Buffer.alloc(1000), false);
    expect(scores.has(ID_A)).toBe(true);
    expect(scores.has(ID_B)).toBe(false);
    expect(scores.has(ID_C)).toBe(true);
  });

  it("lives next to the room's state file", () => {
    expect(scoreStoreDirFor(join("srv", "bandcue", ".bandcue-room.json"))).toBe(join("srv", "bandcue", ".bandcue-scores"));
  });
});
