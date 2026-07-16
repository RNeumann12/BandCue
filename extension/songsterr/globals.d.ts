// Ambient globals for the extension's classic (non-module) scripts, so they
// type-check under tsconfig.web.json. Not shipped: package-extension.ts only
// bundles the files listed in the manifest/HTML.

// Vendored QR decoder (vendor/jsQR.js), loaded via <script> before popup.js
// and scanner.js.
declare function jsQR(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }
): { data: string } | null;

// Shape Detection API (Chrome); used opportunistically by popup.js before
// falling back to jsQR. Not yet in the bundled DOM lib.
declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  detect(source: CanvasImageSource | ImageData | Blob): Promise<Array<{ rawValue: string }>>;
}

// MV3 service-worker global used by background.js; not part of the DOM lib.
declare function importScripts(...urls: string[]): void;

// Shared room-permission helpers (room-permissions.js) attach themselves to
// globalThis for use from both the service worker and the popup.
declare var BandCueRoomPermissions: {
  permissionsForLocator(input: string): { origins: string[]; message: string };
} | undefined;
