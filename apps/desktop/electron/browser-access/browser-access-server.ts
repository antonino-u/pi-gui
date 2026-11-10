import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, rename, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { BROWSER_ACCESS_PREFIX } from "../../contracts/browser-access";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  bridgeScript,
  browserClientScript,
  browserHeadTags,
  serviceWorkerScript,
  webAppManifest,
} from "./browser-scripts";
import { PushRegistry } from "./push-registry";
import { isPushSubscription, sendPush } from "./web-push";
import {
  isAllowedHost,
  isLoopbackAddress,
  isSameOrigin,
  localHostnames,
  readCookie,
  secretsEqual,
} from "./host-guard";

/** A hidden host window that renders for one browser tab. */
export interface BrowserBridgeWindow {
  isDestroyed(): boolean;
  destroy(): void;
  onClosed(listener: () => void): void;
  /** Whether this window's view has the thread open. */
  showsSession(sessionRef: SessionRef): boolean;
}

export type BrowserAccessRendererSource =
  | { readonly kind: "directory"; readonly root: string }
  | { readonly kind: "dev-server"; readonly url: string };

export interface BrowserAccessServerOptions {
  /** Interface to listen on. `127.0.0.1` keeps access on this machine. */
  readonly host: string;
  readonly port: number;
  /** Where the pairing token is kept (readable by this user only). */
  readonly tokenFile: string;
  /** Where the push key pair and browser subscriptions are kept (readable by this user only). */
  readonly pushFile: string;
  /** PEM certificate and key. With both, browsers connect over HTTPS. */
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer };
  /** Served as the web app icon. */
  readonly iconFile?: string;
  /** Contact URL or `mailto:` address sent to push services (VAPID subject). */
  readonly pushContact: string;
  readonly renderer: BrowserAccessRendererSource;
  /** Extra names (for example a local DNS name) that browsers may use to reach this host. */
  readonly extraHostnames?: readonly string[];
  readonly openBridgeWindow: (url: string) => BrowserBridgeWindow;
  /** How long a disconnected tab keeps its window, so a reload or network blip resumes it. */
  readonly reconnectGraceMs?: number;
  readonly maxTabs?: number;
}

interface TabRecord {
  readonly id: string;
  readonly secret: string;
  readonly window: BrowserBridgeWindow;
  instance?: string;
  client?: WebSocket;
  bridge?: WebSocket;
  resumed: boolean;
  visible: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
}

const COOKIE_NAME = "pi_gui_browser";
const ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
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

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

async function loadOrCreateToken(tokenFile: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(tokenFile, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && /^[a-f0-9]{64}$/.test(parsed.token)) {
      return parsed.token;
    }
  } catch {
    // Missing or unreadable: create a new token below.
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(path.dirname(tokenFile), { recursive: true });
  const temporary = `${tokenFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, token }, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, tokenFile);
  return token;
}

/** Phones lay the app out edge to edge, under the notch and home indicator. */
const BROWSER_VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";

function injectClientScript(source: string): string {
  const html = source.replace(
    /<meta\s+name="viewport"[^>]*>/i,
    `<meta name="viewport" content="${BROWSER_VIEWPORT}" />`,
  );
  const tag = browserHeadTags;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return tag + html;
  const end = head.index + head[0].length;
  return html.slice(0, end) + tag + html.slice(end);
}

function rawText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function sendPlain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(message);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Serves pi-gui's renderer to browsers and connects each browser tab to a hidden bridge
 * window on this host. The bridge window loads the real preload, so every request passes
 * through the same IPC handlers, validation and per-window view as a desktop window.
 *
 * Access requires a token: the pairing link sets it as an HttpOnly cookie. Every request
 * must name this machine in its Host header, and sockets must come from this origin.
 */
export class BrowserAccessServer {
  private readonly server: http.Server;
  /** Bridge windows reach the host here: loopback only, on its own port. */
  private readonly bridgeServer = http.createServer((request, response) => {
    this.handleBridgeRequest(request, response);
  });
  private readonly clientSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: { threshold: 1024 },
  });
  private readonly bridgeSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  private readonly tabs = new Map<string, TabRecord>();
  private allowedHostsCache:
    { readonly names: ReadonlySet<string>; readonly at: number } | undefined;
  private readonly push: PushRegistry;
  private pushQueue: Promise<void> = Promise.resolve();
  private token = "";
  private boundPort = 0;
  private bridgePort = 0;

  constructor(private readonly options: BrowserAccessServerOptions) {
    this.push = new PushRegistry(options.pushFile);
    const handle = (request: IncomingMessage, response: ServerResponse) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        console.error("[browser-access] request failed", error);
        if (!response.headersSent) sendPlain(response, 500, "Internal error");
        else response.destroy();
      });
    };
    this.server = options.tls
      ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, handle)
      : http.createServer(handle);
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.bridgeServer.on("upgrade", (request, socket, head) => {
      this.handleBridgeUpgrade(request, socket, head);
    });
  }

  async start(): Promise<void> {
    this.token = await loadOrCreateToken(this.options.tokenFile);
    await this.push.load();
    await new Promise<void>((resolve, reject) => {
      this.bridgeServer.once("error", reject);
      this.bridgeServer.listen(0, "127.0.0.1", () => {
        this.bridgeServer.off("error", reject);
        resolve();
      });
    });
    const bridgeAddress = this.bridgeServer.address();
    this.bridgePort = typeof bridgeAddress === "object" && bridgeAddress ? bridgeAddress.port : 0;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
  }

  async stop(): Promise<void> {
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    this.clientSockets.close();
    this.bridgeSockets.close();
    await Promise.all([
      new Promise<void>((resolve) => this.server.close(() => resolve())),
      new Promise<void>((resolve) => this.bridgeServer.close(() => resolve())),
    ]);
  }

  get port(): number {
    return this.boundPort;
  }

  /** Links that pair a browser. Anyone holding one can use pi-gui as this user. */
  pairingUrls(): string[] {
    const hosts = this.isWildcardHost()
      ? Object.values(os.networkInterfaces())
          .flatMap((infos) => infos ?? [])
          .filter((info) => info.family === "IPv4" && !info.internal)
          .map((info) => info.address)
      : [this.options.host];
    if (hosts.length === 0) hosts.push("127.0.0.1");
    return hosts.map((host) => this.pairingUrl(host.includes(":") ? `[${host}]` : host));
  }

  private get scheme(): "http" | "https" {
    return this.options.tls ? "https" : "http";
  }

  private pairingUrl(host: string, port: number = this.boundPort): string {
    return `${this.scheme}://${host}:${port}${BROWSER_ACCESS_PREFIX}/pair?token=${this.token}`;
  }

  /**
   * Sends a notification to every subscribed browser, unless an on-screen browser tab
   * already shows the thread. Pushes go out one at a time, in order.
   */
  notify(sessionRef: SessionRef, title: string, body: string): void {
    const shownInBrowser = [...this.tabs.values()].some(
      (tab) =>
        tab.visible &&
        tab.client &&
        !tab.window.isDestroyed() &&
        tab.window.showsSession(sessionRef),
    );
    if (shownInBrowser) return;
    const subscriptions = this.push.subscriptions();
    if (subscriptions.length === 0) return;
    const payload = {
      title,
      body,
      tag: `${sessionRef.workspaceId}:${sessionRef.sessionId}`,
      session: sessionRef,
    };
    const deliver = async () => {
      for (const subscription of subscriptions) {
        try {
          const result = await sendPush({
            subscription,
            payload,
            vapid: this.push.vapid,
            subject: this.options.pushContact,
          });
          if (result === "expired") await this.push.remove(subscription.endpoint);
        } catch (error) {
          console.warn("[browser-access] push delivery failed", error);
        }
      }
    };
    this.pushQueue = this.pushQueue.then(deliver, deliver);
  }

  /**
   * This machine's names and addresses. Re-read every few seconds, so a laptop that joins
   * another network keeps working without a restart.
   */
  private get allowedHosts(): ReadonlySet<string> {
    const now = Date.now();
    if (!this.allowedHostsCache || now - this.allowedHostsCache.at > 5_000) {
      this.allowedHostsCache = { names: localHostnames(this.options.extraHostnames), at: now };
    }
    return this.allowedHostsCache.names;
  }

  private isWildcardHost(): boolean {
    return this.options.host === "0.0.0.0" || this.options.host === "::";
  }

  /** The address a bridge window on this host uses to reach the server. */
  private bridgeOrigin(): string {
    return `127.0.0.1:${this.bridgePort}`;
  }

  private isPaired(request: IncomingMessage): boolean {
    return secretsEqual(readCookie(request.headers.cookie, COOKIE_NAME), this.token);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAllowedHost(request.headers.host, this.allowedHosts)) {
      sendPlain(response, 421, "Unknown host");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendPlain(response, 405, "Method not allowed");
      return;
    }
    const url = new URL(request.url ?? "/", "http://host.invalid");

    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/pair`) {
      if (!secretsEqual(url.searchParams.get("token") ?? undefined, this.token)) {
        sendPlain(response, 403, "This pairing link is not valid.");
        return;
      }
      response.writeHead(302, {
        ...BASE_HEADERS,
        "Set-Cookie": `${COOKIE_NAME}=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${this.options.tls ? "; Secure" : ""}`,
        "Cache-Control": "no-store",
        Location: "/",
      });
      response.end();
      return;
    }

    // Fetched by the browser without (or before) the pairing cookie; none holds a secret
    // unless the request is paired.
    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/manifest.webmanifest`) {
      const startUrl = this.isPaired(request)
        ? `${BROWSER_ACCESS_PREFIX}/pair?token=${this.token}`
        : "/";
      this.sendBody(
        request,
        response,
        200,
        "application/manifest+json",
        webAppManifest({ startUrl }),
      );
      return;
    }
    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/sw.js`) {
      response.setHeader("Service-Worker-Allowed", "/");
      this.sendBody(request, response, 200, "text/javascript; charset=utf-8", serviceWorkerScript);
      return;
    }
    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/icon.png` && this.options.iconFile) {
      let icon: Buffer;
      try {
        icon = await readFile(this.options.iconFile);
      } catch {
        sendPlain(response, 404, "Not found");
        return;
      }
      this.sendBody(request, response, 200, "image/png", icon, "max-age=86400");
      return;
    }

    if (!this.isPaired(request)) {
      sendPlain(
        response,
        403,
        "This browser is not paired with pi-gui. Open a pairing link from pi-gui.",
      );
      return;
    }

    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/client.js`) {
      this.sendBody(
        request,
        response,
        200,
        "text/javascript; charset=utf-8",
        browserClientScript({ pushPublicKey: this.push.vapid.publicKey }),
      );
      return;
    }

    if (this.options.renderer.kind === "dev-server") {
      this.proxyToDevServer(request, response, this.options.renderer.url);
      return;
    }
    await this.serveRendererFile(request, response, this.options.renderer.root, url.pathname);
  }

  private sendBody(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    contentType: string,
    body: string | Buffer,
    cacheControl = "no-store",
  ): void {
    const payload = typeof body === "string" ? Buffer.from(body) : body;
    response.writeHead(status, {
      ...BASE_HEADERS,
      "Content-Type": contentType,
      "Content-Length": payload.length,
      "Cache-Control": cacheControl,
    });
    response.end(request.method === "HEAD" ? undefined : payload);
  }

  private isBridgeRequest(request: IncomingMessage): boolean {
    return (
      isLoopbackAddress(request.socket.remoteAddress) &&
      request.headers.host === this.bridgeOrigin()
    );
  }

  private handleBridgeRequest(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://host.invalid");
    const tab = this.tabs.get(url.searchParams.get("tab") ?? "");
    if (
      request.method !== "GET" ||
      url.pathname !== `${BROWSER_ACCESS_PREFIX}/bridge` ||
      !tab ||
      !this.isBridgeRequest(request) ||
      !secretsEqual(url.searchParams.get("key") ?? undefined, tab.secret)
    ) {
      sendPlain(response, 403, "Forbidden");
      return;
    }
    const socketUrl = `ws://${this.bridgeOrigin()}${BROWSER_ACCESS_PREFIX}/bridge-socket?tab=${tab.id}&key=${tab.secret}`;
    response.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>pi-gui bridge</title></head><body><script>${bridgeScript(socketUrl)}</script></body></html>`,
    );
  }

  private async serveRendererFile(
    request: IncomingMessage,
    response: ServerResponse,
    root: string,
    pathname: string,
  ): Promise<void> {
    let relative: string;
    try {
      relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      sendPlain(response, 400, "Bad path");
      return;
    }
    const resolvedRoot = path.resolve(root);
    const filePath = path.resolve(resolvedRoot, `.${path.posix.normalize(relative)}`);
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
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
    const payload = isHtml ? Buffer.from(injectClientScript(body.toString("utf8"))) : body;
    response.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Content-Length": payload.length,
      "Cache-Control": isHtml ? "no-store" : "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : payload);
  }

  private proxyToDevServer(
    request: IncomingMessage,
    response: ServerResponse,
    devUrl: string,
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
          const html = injectClientScript(Buffer.concat(chunks).toString("utf8"));
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
      if (!response.headersSent)
        sendPlain(response, 502, "The development server is not reachable.");
    });
    request.pipe(upstream);
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isAllowedHost(request.headers.host, this.allowedHosts)) {
      rejectUpgrade(socket, 421, "Misdirected Request");
      return;
    }
    const url = new URL(request.url ?? "/", "http://host.invalid");
    if (!isSameOrigin(request.headers.origin, request.headers.host)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/socket`) {
      this.upgradeClient(request, socket, head, url);
      return;
    }
    // Development only: let the renderer's hot-reload socket reach the dev server.
    if (this.options.renderer.kind === "dev-server" && this.isPaired(request)) {
      this.proxyUpgradeToDevServer(request, socket, head, this.options.renderer.url);
      return;
    }
    rejectUpgrade(socket, 404, "Not Found");
  }

  private upgradeClient(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    const tabId = url.searchParams.get("tab") ?? "";
    const instance = url.searchParams.get("instance") ?? "";
    this.clientSockets.handleUpgrade(request, socket, head, (client) => {
      if (!this.isPaired(request)) {
        client.close(4003, "Not paired");
        return;
      }
      if (!ID_PATTERN.test(tabId) || !ID_PATTERN.test(instance)) {
        client.close(4000, "Bad request");
        return;
      }
      this.attachClient(tabId, instance, client);
    });
  }

  private attachClient(tabId: string, instance: string, client: WebSocket): void {
    let tab = this.tabs.get(tabId);
    if (tab && tab.window.isDestroyed()) {
      this.closeTab(tab);
      tab = undefined;
    }
    if (tab?.client && tab.client.readyState === WebSocket.OPEN && tab.instance !== instance) {
      client.close(4001, "Tab in use");
      return;
    }
    if (!tab) {
      if (this.tabs.size >= (this.options.maxTabs ?? 8)) {
        client.close(4002, "Too many browser tabs");
        return;
      }
      tab = this.openTab(tabId);
    } else {
      tab.resumed = true;
    }
    if (tab.graceTimer) clearTimeout(tab.graceTimer);
    tab.graceTimer = undefined;
    const previous = tab.client;
    tab.client = client;
    tab.instance = instance;
    if (previous && previous !== client) previous.close(4001, "Replaced");
    const record = tab;

    client.on("message", (data) => {
      // Calls go to the bridge, which validates the member and its arguments. The host
      // answers host calls and visibility reports itself.
      const text = rawText(data);
      let frame: { t?: unknown; id?: unknown; m?: unknown; a?: unknown; visible?: unknown };
      try {
        frame = JSON.parse(text) as typeof frame;
      } catch {
        return;
      }
      if (frame.t === "call" && record.bridge?.readyState === WebSocket.OPEN) {
        record.bridge.send(text);
      } else if (frame.t === "visibility" && typeof frame.visible === "boolean") {
        record.visible = frame.visible;
      } else if (frame.t === "host" && typeof frame.id === "number") {
        const id = frame.id;
        void this.handleHostCall(frame.m, frame.a).then(
          (value) => this.sendToClient(client, { t: "result", id, ok: true, v: value }),
          (error: unknown) =>
            this.sendToClient(client, {
              t: "result",
              id,
              ok: false,
              e: error instanceof Error ? error.message : String(error),
            }),
        );
      }
    });
    client.on("close", () => {
      if (record.client !== client) return;
      record.client = undefined;
      record.visible = false;
      record.graceTimer = setTimeout(
        () => this.closeTab(record),
        this.options.reconnectGraceMs ?? 60_000,
      );
    });
    client.on("error", () => client.terminate());
    if (record.bridge?.readyState === WebSocket.OPEN) this.announceReady(record);
  }

  private sendToClient(client: WebSocket, frame: unknown): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(frame));
  }

  private async handleHostCall(member: unknown, args: unknown): Promise<unknown> {
    const first = Array.isArray(args) ? (args[0] as unknown) : undefined;
    if (member === "pushSubscribe") {
      if (!isPushSubscription(first)) throw new Error("That push subscription is not valid.");
      await this.push.add(first);
      return true;
    }
    if (member === "resolveFolder") {
      // The browser has no folder picker for the host, so it sends a typed path.
      if (typeof first !== "string" || first.trim().length === 0) {
        throw new Error("Enter a folder path.");
      }
      const typed = first.trim();
      const expanded =
        typed === "~" || typed.startsWith("~/") ? path.join(os.homedir(), typed.slice(1)) : typed;
      if (!path.isAbsolute(expanded)) {
        throw new Error("Enter a full path, such as ~/src/my-project.");
      }
      const info = await stat(expanded).catch(() => undefined);
      if (!info?.isDirectory()) throw new Error(`There is no folder at ${typed}.`);
      return path.resolve(expanded);
    }
    if (member === "pushUnsubscribe") {
      if (typeof first !== "string") throw new Error("An endpoint is required.");
      await this.push.remove(first);
      return true;
    }
    throw new Error("Unknown request.");
  }

  private announceReady(tab: TabRecord): void {
    if (tab.client?.readyState === WebSocket.OPEN) {
      tab.client.send(JSON.stringify({ t: "ready", resumed: tab.resumed }));
    }
  }

  private openTab(tabId: string): TabRecord {
    const secret = randomBytes(32).toString("hex");
    const url = `http://${this.bridgeOrigin()}${BROWSER_ACCESS_PREFIX}/bridge?tab=${tabId}&key=${secret}`;
    // The window loads the bridge page asynchronously, after the record below is registered.
    const window = this.options.openBridgeWindow(url);
    const record: TabRecord = { id: tabId, secret, resumed: false, visible: false, window };
    this.tabs.set(tabId, record);
    window.onClosed(() => {
      if (this.tabs.get(tabId) === record) this.closeTab(record);
    });
    return record;
  }

  private closeTab(tab: TabRecord): void {
    if (this.tabs.get(tab.id) === tab) this.tabs.delete(tab.id);
    if (tab.graceTimer) clearTimeout(tab.graceTimer);
    tab.client?.close(1012, "Window closed");
    tab.bridge?.close();
    if (!tab.window.isDestroyed()) tab.window.destroy();
  }

  private handleBridgeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://host.invalid");
    const tab = this.tabs.get(url.searchParams.get("tab") ?? "");
    if (
      url.pathname !== `${BROWSER_ACCESS_PREFIX}/bridge-socket` ||
      !tab ||
      tab.bridge ||
      !this.isBridgeRequest(request) ||
      !secretsEqual(url.searchParams.get("key") ?? undefined, tab.secret)
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    this.bridgeSockets.handleUpgrade(request, socket, head, (bridge) => {
      tab.bridge = bridge;
      bridge.on("message", (data) => {
        if (tab.client?.readyState === WebSocket.OPEN) tab.client.send(rawText(data));
      });
      bridge.on("close", () => {
        if (tab.bridge === bridge) this.closeTab(tab);
      });
      bridge.on("error", () => bridge.terminate());
      this.announceReady(tab);
    });
  }

  private proxyUpgradeToDevServer(
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
}
