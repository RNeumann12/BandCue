import type { ScoreImportRole, SetlistSong } from "./protocol.js";

// A single setlist song can target more than one app at once: a Songsterr URL
// for band mates and a local MuseScore score for whoever drives playback from
// MuseScore. These resolvers centralize how each app's reference is derived so
// the adapters, server, and web client stay in agreement.
//
// Resolution order for each app: the dedicated field (songsterrUrl /
// museScoreSource) wins; otherwise the primary `source` is used when the
// primary `sourceType` matches that app. This keeps older single-source songs
// working unchanged. Bass/drum Songsterr fields are explicit per-instrument
// overrides for arrangements that live on a different Songsterr song page.

export function appliesToSongsterr(song: SetlistSong | undefined): boolean {
  return Boolean(song) && (
    song!.sourceType === "songsterr" ||
    Boolean(song!.songsterrUrl?.trim()) ||
    Boolean(song!.songsterrBassUrl?.trim()) ||
    Boolean(song!.songsterrDrumUrl?.trim())
  );
}

export function songsterrReference(song: SetlistSong | undefined): string {
  if (!song) {
    return "";
  }

  const dedicated = song.songsterrUrl?.trim();
  if (dedicated) {
    return dedicated;
  }

  return song.sourceType === "songsterr" ? song.source?.trim() ?? "" : "";
}

export function songsterrBassReference(song: SetlistSong | undefined): string {
  return song?.songsterrBassUrl?.trim() || songsterrReference(song);
}

export function songsterrDrumReference(song: SetlistSong | undefined): string {
  return song?.songsterrDrumUrl?.trim() || songsterrReference(song);
}

export function songsterrReferences(song: SetlistSong | undefined): string[] {
  const references = [
    songsterrReference(song),
    song?.songsterrBassUrl?.trim() ?? "",
    song?.songsterrDrumUrl?.trim() ?? ""
  ].filter(Boolean);
  return [...new Set(references)];
}

/**
 * The Songsterr song id in a tab URL (`s<digits>`), or "" without one. The
 * same id as the extension's songKeyFromPath(): instrument slugs and `t<n>`
 * track suffixes do not change it.
 */
export function songsterrSongKey(url: string | undefined): string {
  try {
    const songId = new URL(url ?? "").pathname.match(/-s(\d+)(?:t\d+)?(?:\/|$)/i)?.[1];
    return songId ? `s${songId}` : "";
  } catch {
    return "";
  }
}

/**
 * The Songsterr songs a setlist song's notes can be imported from: one per
 * Songsterr song id, with the URL to open and which roles it serves (the
 * drummer's arrangement may be a different song than the main tab).
 */
export function songsterrImportTargets(song: SetlistSong | undefined): { key: string; url: string; roles: ScoreImportRole[] }[] {
  const targets: { key: string; url: string; roles: ScoreImportRole[] }[] = [];
  const add = (url: string, role: ScoreImportRole) => {
    const key = songsterrSongKey(url);
    if (!key) {
      return;
    }
    const existing = targets.find((target) => target.key === key);
    if (existing) {
      existing.roles.push(role);
    } else {
      targets.push({ key, url, roles: [role] });
    }
  };
  add(songsterrReference(song), "main");
  add(song?.songsterrBassUrl?.trim() ?? "", "bass");
  add(song?.songsterrDrumUrl?.trim() ?? "", "drums");
  return targets;
}

/** Whether a song can show notes: a MuseScore score or a Songsterr import. */
export function hasScoreView(song: SetlistSong | undefined): boolean {
  return appliesToMuseScore(song) || Boolean(song?.scoreImports?.length);
}

export function appliesToMuseScore(song: SetlistSong | undefined): boolean {
  return Boolean(song) && (song!.sourceType === "musescore" || Boolean(song!.museScoreSource?.trim()));
}

export function museScoreReference(song: SetlistSong | undefined): string {
  if (!song) {
    return "";
  }

  const dedicated = song.museScoreSource?.trim();
  if (dedicated) {
    return dedicated;
  }

  return song.sourceType === "musescore" ? song.source?.trim() ?? "" : "";
}
