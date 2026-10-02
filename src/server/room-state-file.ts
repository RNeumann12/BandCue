import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Where the room's setlist and current song are kept between coordinator runs:
 * next to the identity file, e.g. `.bandcue-room.json` -> `.bandcue-room.setlist.json`.
 */
export function roomStatePathFor(identityPath: string): string {
  return identityPath.replace(/(\.json)?$/i, ".setlist.json");
}

/** The saved state, or undefined when there is none or it cannot be read. */
export function readRoomStateFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Writes the latest state at most once per `debounceMs`. Each write goes to a
 * temporary file that then replaces the real one, so a coordinator killed
 * mid-write (a pulled power plug on the Pi) leaves the previous setlist intact
 * instead of half a JSON file.
 */
export function createRoomStateWriter(path: string, debounceMs = 400) {
  let pending: unknown;
  let hasPending = false;
  let timer: NodeJS.Timeout | undefined;
  let lastError = "";

  const write = (): void => {
    timer = undefined;
    if (!hasPending) {
      return;
    }
    const state = pending;
    hasPending = false;
    pending = undefined;
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temporary, path);
      lastError = "";
    } catch (error) {
      // Saving is a convenience; the room keeps running from memory. Say so
      // once per distinct problem rather than on every setlist edit.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) {
        lastError = message;
        console.warn(`Could not save the setlist to ${path}: ${message}`);
      }
    }
  };

  return {
    schedule(state: unknown): void {
      pending = state;
      hasPending = true;
      if (!timer) {
        timer = setTimeout(write, debounceMs);
        timer.unref?.();
      }
    },
    /** Writes anything still pending right away (on shutdown). */
    flush(): void {
      if (timer) {
        clearTimeout(timer);
      }
      write();
    }
  };
}
