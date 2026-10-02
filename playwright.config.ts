import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Browser-level smoke tests for the host workflow (e2e/). Vitest owns unit
// tests; Playwright boots the real coordinator and drives the served host page
// so the DOM ids ↔ app.js ↔ WebSocket ↔ room wiring is covered end to end.
// Run with `npm run test:e2e` (needs `npx playwright install chromium` once).
const PORT = 4599;
// A fresh state directory per run: the coordinator now saves the setlist, and
// one run's songs must not show up in the next.
const STATE_DIR = process.env.BANDCUE_E2E_STATE_DIR ??= mkdtempSync(join(tmpdir(), "bandcue-e2e-"));

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`
  },
  webServer: {
    command: "npx tsx src/server/index.ts",
    url: `http://127.0.0.1:${PORT}/api/room`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      BANDCUE_TOKEN: "e2e-room-token",
      BANDCUE_HOST_TOKEN: "e2e-host-token",
      BANDCUE_ROOM_CODE: "E2E0FF",
      // Keep the e2e run from clobbering a real rehearsal's persisted identity.
      BANDCUE_STATE_FILE: join(STATE_DIR, "room.json")
    }
  }
});
