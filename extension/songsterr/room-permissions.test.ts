import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const permissionsSource = readFileSync(
  fileURLToPath(new URL("./room-permissions.js", import.meta.url)),
  "utf8"
);

const manifest = JSON.parse(readFileSync(
  fileURLToPath(new URL("./manifest.json", import.meta.url)),
  "utf8"
));

function loadPermissions() {
  const context: any = { URL };
  vm.createContext(context);
  vm.runInContext(permissionsSource, context);
  return context.BandCueRoomPermissions;
}

describe("extension manifest permissions", () => {
  it("keeps broad LAN permissions optional for Chrome Web Store review", () => {
    expect(manifest.host_permissions).toEqual([
      "https://www.songsterr.com/*",
      "https://songsterr.com/*"
    ]);
    expect(manifest.optional_host_permissions).toEqual(["http://*/*"]);
  });

  it("ships the permission helper before popup logic", () => {
    const popupHtml = readFileSync(
      fileURLToPath(new URL("./popup.html", import.meta.url)),
      "utf8"
    );

    expect(popupHtml.indexOf("room-permissions.js")).toBeGreaterThan(-1);
    expect(popupHtml.indexOf("room-permissions.js")).toBeLessThan(popupHtml.indexOf("popup.js"));
  });
});

describe("BandCueRoomPermissions", () => {
  it("requests broad LAN access for room-code discovery", () => {
    const permissions = loadPermissions();

    expect(permissions.permissionsForLocator("ABC123")).toEqual({
      origins: ["http://*/*"],
      requiresBroadLanAccess: true,
      message: "Approve local network access so BandCue can find the rehearsal room on this Wi-Fi."
    });
  });

  it("requests broad LAN access for port-only discovery", () => {
    const permissions = loadPermissions();

    expect(permissions.permissionsForLocator("4173").origins).toEqual(["http://*/*"]);
  });

  it("requests host-scoped access for explicit hosts", () => {
    const permissions = loadPermissions();

    expect(permissions.permissionsForLocator("192.168.1.23:4173").origins).toEqual([
      "http://192.168.1.23/*"
    ]);
  });

  it("requests host-scoped access for full room URLs", () => {
    const permissions = loadPermissions();

    expect(permissions.permissionsForLocator("http://127.0.0.1:4173/?token=TEST").origins).toEqual([
      "http://127.0.0.1/*"
    ]);
  });

  it("rejects unusable locators before requesting permissions", () => {
    const permissions = loadPermissions();

    expect(permissions.permissionsForLocator("not a host name").origins).toEqual([]);
  });
});
