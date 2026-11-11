import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { BASE_HEADERS, sendPlain } from "./http-responses";

export type BrowserAccessRendererSource =
  | { readonly kind: "directory"; readonly root: string }
  | { readonly kind: "dev-server"; readonly url: string };

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

/** Rewrites an HTML page before it reaches the browser (adds the browser client). */
export type HtmlTransform = (html: string) => string;

/**
 * Serves pi-gui's renderer: the built files, or in development the renderer's dev server.
 * HTML pages pass through `transform`; nothing outside the renderer directory is served.
 */
export async function serveRenderer(
  source: BrowserAccessRendererSource,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  transform: HtmlTransform,
): Promise<void> {
  if (source.kind === "dev-server") {
    proxyToDevServer(request, response, source.url, transform);
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    sendPlain(response, 400, "Bad path");
    return;
  }
  const root = path.resolve(source.root);
  const filePath = path.resolve(root, `.${path.posix.normalize(relative)}`);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    sendPlain(response, 404, "Not found");
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    sendPlain(response, 404, "Not found");
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  const isHtml = extension === ".html";
  const payload = isHtml ? Buffer.from(transform(body.toString("utf8"))) : body;
  response.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "Content-Length": payload.length,
    "Cache-Control": isHtml ? "no-store" : "no-cache",
  });
  response.end(request.method === "HEAD" ? undefined : payload);
}

function proxyToDevServer(
  request: IncomingMessage,
  response: ServerResponse,
  devUrl: string,
  transform: HtmlTransform,
): void {
  const target = new URL(devUrl);
  const headers = { ...request.headers, host: target.host };
  delete headers.cookie;
  delete headers["accept-encoding"];
  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      const contentType = String(upstreamResponse.headers["content-type"] ?? "");
      if (!contentType.includes("text/html")) {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        return;
      }
      const chunks: Buffer[] = [];
      upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const html = transform(Buffer.concat(chunks).toString("utf8"));
        const { "content-length": _length, ...rest } = upstreamResponse.headers;
        response.writeHead(upstreamResponse.statusCode ?? 200, {
          ...rest,
          "cache-control": "no-store",
        });
        response.end(html);
      });
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) sendPlain(response, 502, "The development server is not reachable.");
  });
  request.pipe(upstream);
}

/** Development only: lets the renderer's hot-reload socket reach the dev server. */
export function proxyUpgradeToDevServer(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  devUrl: string,
): void {
  const target = new URL(devUrl);
  const upstream = net.connect(Number(target.port) || 80, target.hostname, () => {
    const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index] ?? "";
      const value = request.rawHeaders[index + 1] ?? "";
      const lower = name.toLowerCase();
      if (lower === "cookie") continue;
      lines.push(
        `${name}: ${lower === "host" ? target.host : lower === "origin" ? target.origin : value}`,
      );
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}
