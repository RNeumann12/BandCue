import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_PLUGIN_ACTION,
  BRIDGE_PLUGIN_SHORTCUT,
  BRIDGE_PLUGIN_URI,
  pluginVersion,
  pluginsFolderFromSettings,
  setUpBridgePlugin,
  withBridgePluginEnabled,
  withBridgeShortcut
} from "./musescore-plugin-setup.js";

const USER_SHORTCUTS = `<?xml version="1.0" encoding="UTF-8"?>
<Shortcuts>
  <SC>
    <key>nav-right</key>
    <seq>Right</seq>
    </SC>
</Shortcuts>
`;

describe("MuseScore bridge plugin setup", () => {
  it("adds the plugin shortcut next to the user's own, once", () => {
    const added = withBridgeShortcut(USER_SHORTCUTS);
    expect(added?.changed).toBe(true);
    expect(added?.text).toContain("<key>nav-right</key>");
    expect(added?.text).toContain(`<key>${BRIDGE_PLUGIN_ACTION}</key>`);
    expect(added?.text).toContain(`<seq>${BRIDGE_PLUGIN_SHORTCUT}</seq>`);
    expect(added?.text.trimEnd().endsWith("</Shortcuts>")).toBe(true);

    expect(withBridgeShortcut(added?.text)).toEqual({ text: added?.text, changed: false });
  });

  it("puts a rebound or duplicated plugin shortcut back on the chord the adapter types", () => {
    const rebound = USER_SHORTCUTS.replace("</Shortcuts>",
      `  <SC>\n    <key>${BRIDGE_PLUGIN_ACTION}</key>\n    <seq>Ctrl+Shift+F12</seq>\n    </SC>\n</Shortcuts>`);
    const fixed = withBridgeShortcut(rebound);

    expect(fixed?.changed).toBe(true);
    expect(fixed?.text).not.toContain("Ctrl+Shift+F12");
    expect(fixed?.text.split(BRIDGE_PLUGIN_ACTION)).toHaveLength(2);
  });

  it("creates a shortcuts file MuseScore will merge with its defaults, and refuses a foreign one", () => {
    expect(withBridgeShortcut(undefined)?.text).toContain(`<Shortcuts>\n  <SC>\n    <key>${BRIDGE_PLUGIN_ACTION}</key>`);
    expect(withBridgeShortcut("<nope/>")).toBeUndefined();
  });

  it("enables the plugin to run on request, replacing a disabled or automatic setting", () => {
    const disabled = JSON.stringify([
      { actions: [], uri: "musescore://extensions/colornotes" },
      { actions: [{ code: "main", exec_point: "onpost_project_opened" }], uri: BRIDGE_PLUGIN_URI }
    ]);
    const enabled = withBridgePluginEnabled(disabled);
    const entries = JSON.parse(enabled?.text ?? "[]") as Array<{ uri: string; actions: unknown[] }>;

    expect(enabled?.changed).toBe(true);
    expect(entries.find((entry) => entry.uri === BRIDGE_PLUGIN_URI)?.actions)
      .toEqual([{ code: "main", exec_point: "manually" }]);
    expect(entries).toHaveLength(2);
    expect(withBridgePluginEnabled(enabled?.text)?.changed).toBe(false);
  });

  it("adds an entry for a plugin MuseScore has not configured yet", () => {
    const added = withBridgePluginEnabled("[]");
    expect(JSON.parse(added?.text ?? "[]")).toEqual([
      { actions: [{ code: "main", exec_point: "manually" }], uri: BRIDGE_PLUGIN_URI }
    ]);
    expect(withBridgePluginEnabled("{ broken")).toBeUndefined();
  });

  it("finds the Plugins folder in MuseScore's preferences, or under Documents", () => {
    expect(pluginsFolderFromSettings(undefined, "C:\\Users\\me\\OneDrive\\Dokumente"))
      .toBe(join("C:\\Users\\me\\OneDrive\\Dokumente", "MuseScore4", "Plugins"));
    expect(pluginsFolderFromSettings("[application]\npaths\\myPlugins=D:/Music/Plugins\n", "C:\\Docs"))
      .toBe("D:\\Music\\Plugins");
    // A Plugins setting in another section is not MuseScore's plugin folder.
    expect(pluginsFolderFromSettings("[ui]\npaths\\myPlugins=D:/Nope\n", "C:\\Docs"))
      .toBe(join("C:\\Docs", "MuseScore4", "Plugins"));
  });

  it("reads the plugin version", () => {
    expect(pluginVersion('MuseScore {\n  version: "2.0"\n}')).toBe("2.0");
    expect(pluginVersion(readFileSync("extension/musescore/bandcue.qml", "utf8"))).toMatch(/^\d+\.\d+$/u);
  });

  it("installs the plugin and settings, and says when MuseScore has to restart", () => {
    const root = mkdtempSync(join(tmpdir(), "bandcue-plugin-"));
    const appData = join(root, "LocalAppData", "MuseScore", "MuseScore4");
    mkdirSync(join(appData, "extensions"), { recursive: true });
    writeFileSync(join(appData, "shortcuts.xml"), USER_SHORTCUTS);
    writeFileSync(join(appData, "extensions", "config.json"), "[]");
    const bundled = join(root, "bandcue.qml");
    writeFileSync(bundled, 'MuseScore {\n  version: "2.0"\n}\n');
    const paths = {
      bundledPlugin: bundled,
      documentsFolder: join(root, "Documents"),
      settingsFile: join(root, "missing.ini"),
      appDataFolder: appData
    };

    const first = setUpBridgePlugin(paths, true);
    expect(first).toMatchObject({
      pluginChanged: true,
      shortcutChanged: true,
      enabledChanged: true,
      restartNeeded: true,
      problems: []
    });
    expect(readFileSync(join(root, "Documents", "MuseScore4", "Plugins", "bandcue", "bandcue.qml"), "utf8"))
      .toContain('version: "2.0"');

    const second = setUpBridgePlugin(paths, true);
    expect(second).toMatchObject({
      pluginChanged: false,
      shortcutChanged: false,
      enabledChanged: false,
      restartNeeded: false
    });

    // New code of the same kind of plugin loads on its next run; no restart.
    writeFileSync(bundled, 'MuseScore {\n  version: "2.1"\n}\n');
    expect(setUpBridgePlugin(paths, true)).toMatchObject({ pluginChanged: true, restartNeeded: false });
  });

  it("asks for a restart when the installed plugin was the old dialog kind", () => {
    const root = mkdtempSync(join(tmpdir(), "bandcue-plugin-"));
    const appData = join(root, "MuseScore4");
    mkdirSync(join(appData, "extensions"), { recursive: true });
    writeFileSync(join(appData, "shortcuts.xml"), withBridgeShortcut(undefined)?.text ?? "");
    writeFileSync(join(appData, "extensions", "config.json"), withBridgePluginEnabled("[]")?.text ?? "");
    const installed = join(root, "Documents", "MuseScore4", "Plugins", "bandcue");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "bandcue.qml"), 'MuseScore {\n  version: "1.3"\n  pluginType: "dialog"\n}\n');
    const bundled = join(root, "bandcue.qml");
    writeFileSync(bundled, 'MuseScore {\n  version: "2.0"\n}\n');

    expect(setUpBridgePlugin({
      bundledPlugin: bundled,
      documentsFolder: join(root, "Documents"),
      settingsFile: join(root, "missing.ini"),
      appDataFolder: appData
    }, true)).toMatchObject({ pluginChanged: true, shortcutChanged: false, enabledChanged: false, restartNeeded: true });
  });

  it("leaves MuseScore's settings alone until MuseScore has run once", () => {
    const root = mkdtempSync(join(tmpdir(), "bandcue-plugin-"));
    const bundled = join(root, "bandcue.qml");
    writeFileSync(bundled, "MuseScore {}\n");

    const result = setUpBridgePlugin({
      bundledPlugin: bundled,
      documentsFolder: join(root, "Documents"),
      settingsFile: join(root, "missing.ini"),
      appDataFolder: join(root, "never-ran")
    }, false);

    expect(result).toMatchObject({ pluginChanged: true, missingAppData: true, restartNeeded: false });
  });
});
