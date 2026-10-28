import { createHash } from "node:crypto";

// A Songsterr import arrives as the Guitar Pro file Songsterr generates for a
// tab ("Download → Guitar Pro", every track). The coordinator only stores it;
// the MuseScore helper converts it. These checks keep anything that is plainly
// not a Guitar Pro file out of the store.

export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

/** GP7/8 (`.gp`, a zip), GPX (`BCFZ`/`BCFS`) or GP3-5 (`FICHIER GUITAR PRO`). */
export function isGuitarProFile(body: Buffer): boolean {
  if (body.length < 32) {
    return false;
  }
  if (body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04) {
    return true;
  }
  const head = body.subarray(0, 4).toString("latin1");
  if (head === "BCFZ" || head === "BCFS") {
    return true;
  }
  return body.subarray(1, 19).toString("latin1") === "FICHIER GUITAR PRO";
}

/** Content hash naming the file in the score store (`/api/scores/<importId>/source.gp`). */
export function importIdFor(body: Buffer): string {
  return createHash("sha256").update("bandcue-songsterr-import\n").update(body).digest("hex").slice(0, 32);
}

export const SONGSTERR_KEY_PATTERN = /^s\d{1,12}$/;
