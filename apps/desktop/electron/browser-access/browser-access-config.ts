import { isIP } from "node:net";

export const DEFAULT_BROWSER_ACCESS_PORT = 7480;
export const BROWSER_ACCESS_ENV = "PI_APP_BROWSER_ACCESS";
export const BROWSER_ACCESS_HOSTNAMES_ENV = "PI_APP_BROWSER_ACCESS_HOSTNAMES";

export interface BrowserAccessConfig {
  readonly host: string;
  readonly port: number;
  readonly extraHostnames: readonly string[];
}

/**
 * Reads the opt-in setting. Browser access stays off unless the variable is set:
 *
 * - `1` or `on`: this machine only, `127.0.0.1:7480`.
 * - `<port>`: this machine only, on that port.
 * - `<address>:<port>` or `[<ipv6>]:<port>`: listen on that interface, for example a home
 *   network address or `0.0.0.0` for every interface.
 */
export function parseBrowserAccessConfig(
  env: Readonly<Record<string, string | undefined>>,
): BrowserAccessConfig | undefined {
  const raw = env[BROWSER_ACCESS_ENV]?.trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "off") return undefined;
  const extraHostnames = (env[BROWSER_ACCESS_HOSTNAMES_ENV] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (raw === "1" || raw.toLowerCase() === "on") {
    return { host: "127.0.0.1", port: DEFAULT_BROWSER_ACCESS_PORT, extraHostnames };
  }
  if (/^\d+$/.test(raw)) {
    return { host: "127.0.0.1", port: parsePort(raw), extraHostnames };
  }
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(raw);
  const plain = /^([^:]+):(\d+)$/.exec(raw);
  const match = bracketed ?? plain;
  if (!match) throw new Error(`${BROWSER_ACCESS_ENV} must be "1", a port, or address:port.`);
  const host = match[1] ?? "";
  if (isIP(host) === 0 && host !== "localhost") {
    throw new Error(`${BROWSER_ACCESS_ENV} must name an IP address, not "${host}".`);
  }
  return { host, port: parsePort(match[2] ?? ""), extraHostnames };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${BROWSER_ACCESS_ENV} has an invalid port: ${raw}`);
  }
  return port;
}
