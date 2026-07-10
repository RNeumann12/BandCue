export const DEFAULT_COORDINATOR_PORT = 4173;

/** Parse a TCP/UDP port without accepting Number() quirks such as blanks. */
export function parsePort(
  value: string | undefined,
  name: string,
  fallback = DEFAULT_COORDINATOR_PORT
): number {
  const candidate = value === undefined ? String(fallback) : value.trim();
  if (!/^\d+$/u.test(candidate)) {
    throw new Error(`${name} must be an integer between 1 and 65535; received ${JSON.stringify(value)}.`);
  }

  const port = Number(candidate);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535; received ${JSON.stringify(value)}.`);
  }

  return port;
}
