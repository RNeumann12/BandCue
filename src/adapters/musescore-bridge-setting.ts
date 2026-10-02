/** The localhost port MuseScore's BandCue Bridge plugin connects to. */
export const DEFAULT_BRIDGE_PORT = 4731;

/**
 * Bridge mode is the default: the plugin starts on the beat and at the right
 * bar, and changes songs inside the running MuseScore, where keystrokes can do
 * neither. This reads the BANDCUE_MUSESCORE_BRIDGE setting (or a launcher flag's
 * value): unset or truthy means the default port, a number that port, and
 * 0/false/no/off keyboard-only control (undefined).
 */
export function bridgePortFromSetting(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /^(true|yes|on)$/i.test(trimmed)) {
    return DEFAULT_BRIDGE_PORT;
  }
  if (/^(0|false|no|off)$/i.test(trimmed)) {
    return undefined;
  }
  // "1" historically meant "on, default port" rather than port 1.
  const port = Number.parseInt(trimmed, 10);
  return Number.isInteger(port) && port > 1 && port <= 65535 ? port : DEFAULT_BRIDGE_PORT;
}
