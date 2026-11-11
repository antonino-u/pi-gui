import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

export function sendPlain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(message);
}

export function sendBody(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const payload = typeof body === "string" ? Buffer.from(body) : body;
  response.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(request.method === "HEAD" ? undefined : payload);
}

export function redirect(
  response: ServerResponse,
  location: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(302, {
    ...BASE_HEADERS,
    "Cache-Control": "no-store",
    Location: location,
    ...extraHeaders,
  });
  response.end();
}

export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function rawText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
