import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";

/** Removes a `:port` suffix and IPv6 brackets, and lowercases the name. */
export function hostnameFromHostHeader(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? undefined : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(":");
  // A bare IPv6 literal has several colons and no port.
  if (colon !== -1 && trimmed.indexOf(":") === colon) return trimmed.slice(0, colon);
  return trimmed;
}

/**
 * Names this machine answers to. A request whose Host header is anything else is refused,
 * which blocks DNS rebinding: a page on another site cannot point its own name at this host.
 */
export function localHostnames(extraHostnames: readonly string[] = []): ReadonlySet<string> {
  const names = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) names.add(info.address.toLowerCase());
  }
  const hostname = os.hostname().toLowerCase();
  if (hostname) {
    names.add(hostname);
    if (!hostname.endsWith(".local")) names.add(`${hostname}.local`);
  }
  for (const extra of extraHostnames) {
    const name = extra.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

export function isAllowedHost(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  const hostname = hostnameFromHostHeader(host);
  return hostname !== undefined && allowed.has(hostname);
}

/** A WebSocket upgrade must come from a page served by this same origin. */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && url.host === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/i, "");
  return normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

/** True when the peer address belongs to this machine (loopback or one of its interfaces). */
export function isLocalPeer(address: string | undefined): boolean {
  if (!address) return false;
  if (isLoopbackAddress(address)) return true;
  const normalized = address.replace(/^::ffff:/i, "").toLowerCase();
  return Object.values(os.networkInterfaces()).some((infos) =>
    (infos ?? []).some((info) => info.address.toLowerCase() === normalized),
  );
}

export function secretsEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}
