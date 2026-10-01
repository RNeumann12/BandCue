import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Keeps MuseScore set up for the BandCue Bridge plugin, so a rehearsal never
 * depends on someone having clicked through MuseScore's plugin manager.
 *
 * Three things have to be true for the adapter to start the plugin on its own:
 * the current `bandcue.qml` is in MuseScore's Plugins folder, MuseScore has the
 * plugin enabled, and a keyboard shortcut runs it. The shortcut is how the
 * adapter starts it -- MuseScore 4.7's "run automatically after a score opens"
 * setting fails for every plugin (it looks the plugin up under an `action://`
 * URI that no plugin is registered under), and the old route through the
 * Plug-Ins menu depended on the menu's order and on nothing else having focus.
 *
 * MuseScore reads all three when it starts, so a change made while it runs only
 * takes effect after a restart; `restartNeeded` says when that is the case.
 */

/** The folder name under Plugins, which is also what MuseScore builds the plugin's URI from. */
export const BRIDGE_PLUGIN_FOLDER = "bandcue";
export const BRIDGE_PLUGIN_FILE = "bandcue.qml";
export const BRIDGE_PLUGIN_URI = `musescore://extensions/v1/${BRIDGE_PLUGIN_FOLDER}/${BRIDGE_PLUGIN_FILE}`;
/** The UI action MuseScore registers for the plugin, which a shortcut binds to. */
export const BRIDGE_PLUGIN_ACTION = `action://extensions/v1/${BRIDGE_PLUGIN_FOLDER}/${BRIDGE_PLUGIN_FILE}?action=main`;
/**
 * Free in MuseScore's default shortcuts, and apart from the adapter's own global
 * hotkeys, which are Ctrl+Alt without Shift. Not an F-key: MuseScore resolved
 * Ctrl+Shift+F12 to its plain-F12 Timeline toggle when the chord was typed.
 */
export const BRIDGE_PLUGIN_SHORTCUT = "Ctrl+Alt+Shift+B";
/** The same chord in SendKeys notation. */
export const BRIDGE_PLUGIN_SENDKEYS = "^%+b";

export interface BridgePluginPaths {
  /** The plugin that ships with this checkout of BandCue. */
  bundledPlugin: string;
  /** Windows' Documents folder, which may be redirected (OneDrive). */
  documentsFolder: string;
  /** `%APPDATA%\MuseScore\MuseScore4.ini`, for a Plugins folder moved in MuseScore's preferences. */
  settingsFile: string;
  /** `%LOCALAPPDATA%\MuseScore\MuseScore4`, where MuseScore keeps shortcuts and plugin settings. */
  appDataFolder: string;
}

export interface BridgePluginSetup {
  pluginFile?: string;
  pluginChanged: boolean;
  shortcutChanged: boolean;
  enabledChanged: boolean;
  /**
   * A MuseScore that is running now cannot start the current plugin by its
   * shortcut until it restarts: it did not know the plugin, the shortcut, or the
   * plugin's enabled state, or it knows the plugin as a different type.
   */
  restartNeeded: boolean;
  /** Set when MuseScore has never run here, so it has no settings to extend yet. */
  missingAppData: boolean;
  problems: string[];
}

export function setUpBridgePlugin(paths: BridgePluginPaths, museScoreRunning: boolean): BridgePluginSetup {
  const result: BridgePluginSetup = {
    pluginChanged: false,
    shortcutChanged: false,
    enabledChanged: false,
    restartNeeded: false,
    missingAppData: false,
    problems: []
  };

  // Whether a running MuseScore still knows the plugin as something else. It
  // reads the plugin's title and type once, at startup; the code itself is
  // loaded fresh every time the plugin runs.
  let pluginNeedsRestart = false;
  try {
    const bundled = readFileSync(paths.bundledPlugin, "utf8");
    const pluginsFolder = pluginsFolderFromSettings(readOptional(paths.settingsFile), paths.documentsFolder);
    const target = join(pluginsFolder, BRIDGE_PLUGIN_FOLDER, BRIDGE_PLUGIN_FILE);
    result.pluginFile = target;
    const installed = readOptional(target);
    if (installed !== bundled) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bundled, "utf8");
      result.pluginChanged = true;
      pluginNeedsRestart = installed === undefined || pluginType(installed) !== pluginType(bundled);
    }
  } catch (error) {
    result.problems.push(`could not install the BandCue Bridge plugin: ${describeError(error)}`);
  }

  if (!existsSync(paths.appDataFolder)) {
    result.missingAppData = true;
  } else {
    const shortcutsFile = join(paths.appDataFolder, "shortcuts.xml");
    try {
      const shortcuts = withBridgeShortcut(readOptional(shortcutsFile));
      if (shortcuts === undefined) {
        result.problems.push(`${shortcutsFile} is not a MuseScore shortcuts file; the plugin shortcut was not added`);
      } else if (shortcuts.changed) {
        writeFileSync(shortcutsFile, shortcuts.text, "utf8");
        result.shortcutChanged = true;
      }
    } catch (error) {
      result.problems.push(`could not add the plugin shortcut: ${describeError(error)}`);
    }

    const extensionsFile = join(paths.appDataFolder, "extensions", "config.json");
    try {
      const extensions = withBridgePluginEnabled(readOptional(extensionsFile));
      if (extensions === undefined) {
        result.problems.push(`${extensionsFile} is not a MuseScore plugin settings file; the plugin was not enabled`);
      } else if (extensions.changed) {
        mkdirSync(dirname(extensionsFile), { recursive: true });
        writeFileSync(extensionsFile, extensions.text, "utf8");
        result.enabledChanged = true;
      }
    } catch (error) {
      result.problems.push(`could not enable the plugin: ${describeError(error)}`);
    }
  }

  result.restartNeeded = museScoreRunning
    && (pluginNeedsRestart || result.shortcutChanged || result.enabledChanged);
  return result;
}

/** A dialog plugin runs as a window and a plain one without; MuseScore decides which at startup. */
function pluginType(qml: string): string {
  return qml.match(/^\s*pluginType:\s*"([^"]*)"/mu)?.[1] ?? "";
}

/**
 * MuseScore's Plugins folder: the one set in its preferences, or the default
 * under Documents. Documents has to come from Windows rather than from
 * `%USERPROFILE%\Documents`, which is a stale, never-scanned folder when
 * Documents is redirected to OneDrive.
 */
export function pluginsFolderFromSettings(settings: string | undefined, documentsFolder: string): string {
  let section = "";
  for (const rawLine of (settings ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    const header = line.match(/^\[(.+)\]$/u);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    const setting = line.match(/^([^=]+)=(.*)$/u);
    if (!setting) {
      continue;
    }
    const key = `${section}\\${setting[1]?.trim() ?? ""}`.replace(/^\\/u, "").toLowerCase();
    const value = (setting[2] ?? "").trim().replace(/^"(.*)"$/u, "$1");
    if (key === "application\\paths\\myplugins" && value) {
      return value.replace(/\//gu, "\\");
    }
  }
  return join(documentsFolder, "MuseScore4", "Plugins");
}

/**
 * Adds the plugin's shortcut to MuseScore's user shortcuts, or returns
 * undefined for a file that is not one. MuseScore merges this file with its
 * built-in defaults, so a file holding only this entry is complete -- which is
 * also why a missing file is simply created.
 */
export function withBridgeShortcut(xml: string | undefined): { text: string; changed: boolean } | undefined {
  const entry = [
    "  <SC>",
    `    <key>${BRIDGE_PLUGIN_ACTION}</key>`,
    `    <seq>${BRIDGE_PLUGIN_SHORTCUT}</seq>`,
    "    </SC>"
  ].join("\n");

  if (!xml?.trim()) {
    return {
      text: `<?xml version="1.0" encoding="UTF-8"?>\n<Shortcuts>\n${entry}\n</Shortcuts>\n`,
      changed: true
    };
  }

  const close = xml.lastIndexOf("</Shortcuts>");
  if (close < 0) {
    return undefined;
  }

  const blocks = /[ \t]*<SC>[\s\S]*?<\/SC>[ \t]*\r?\n?/gu;
  const isOurs = (block: string) => block.includes(`<key>${BRIDGE_PLUGIN_ACTION}</key>`);
  const ours = [...xml.matchAll(blocks)].map((match) => match[0]).filter(isOurs);
  if (ours.length === 1 && ours[0]?.includes(`<seq>${BRIDGE_PLUGIN_SHORTCUT}</seq>`)) {
    return { text: xml, changed: false };
  }

  // Rebound or duplicated: replace every copy with the one the adapter types.
  const cleaned = xml.replace(blocks, (block) => (isOurs(block) ? "" : block));
  const cleanedClose = cleaned.lastIndexOf("</Shortcuts>");
  return {
    text: `${cleaned.slice(0, cleanedClose).replace(/\s*$/u, "\n")}${entry}\n${cleaned.slice(cleanedClose)}`,
    changed: true
  };
}

/**
 * Makes sure MuseScore has the plugin enabled, or returns undefined for a file
 * that is not MuseScore's plugin settings.
 *
 * Enabled means "manually": run on request, which is what the shortcut does.
 * Any other run setting is replaced -- "disabled" would keep the shortcut from
 * existing, and MuseScore 4.7's automatic run points fail with an assertion.
 */
export function withBridgePluginEnabled(json: string | undefined): { text: string; changed: boolean } | undefined {
  let entries: unknown;
  try {
    entries = json?.trim() ? JSON.parse(json) : [];
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) {
    return undefined;
  }

  const enabledActions = [{ code: "main", exec_point: "manually" }];
  const entry = entries.find((candidate): candidate is Record<string, unknown> =>
    Boolean(candidate) && typeof candidate === "object" && (candidate as Record<string, unknown>).uri === BRIDGE_PLUGIN_URI);
  if (!entry) {
    entries.push({ actions: enabledActions, uri: BRIDGE_PLUGIN_URI });
    return { text: `${JSON.stringify(entries, null, 2)}\n`, changed: true };
  }

  const actions = Array.isArray(entry.actions) ? entry.actions as Array<Record<string, unknown>> : [];
  const main = actions.find((action) => action?.code === "main");
  if (main?.exec_point === "manually") {
    return { text: json ?? "", changed: false };
  }
  entry.actions = enabledActions;
  return { text: `${JSON.stringify(entries, null, 2)}\n`, changed: true };
}

/** The `version:` line of a plugin file, so an out-of-date running copy can be named. */
export function pluginVersion(qml: string | undefined): string | undefined {
  return qml?.match(/^\s*version:\s*"([^"]+)"/mu)?.[1];
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
