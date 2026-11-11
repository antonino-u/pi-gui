import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  BROWSER_ACCESS_PREFIX,
  type BrowserAccessStatus,
  type BrowserPairingCode,
} from "../../contracts/browser-access";
import {
  BROWSER_ACCESS_SCRIPTS,
  bridgeHtml,
  browserIndexHtml,
  webAppManifest,
  type BrowserAccessScript,
} from "./browser-documents";
import { DeviceRegistry } from "./device-registry";
import {
  isAllowedHost,
  isLoopbackAddress,
  isSameOrigin,
  localHostnames,
  readCookie,
  secretsEqual,
} from "./host-guard";
import { rawText, redirect, rejectUpgrade, sendBody, sendPlain } from "./http-responses";
import { pairingPageHtml } from "./pairing-page";
import { PushRegistry } from "./push-registry";
import { qrSvg } from "./qr-svg";
import {
  proxyUpgradeToDevServer,
  serveRenderer,
  type BrowserAccessRendererSource,
} from "./renderer-files";
import { readJsonFile, writeSecureJsonFile } from "./secure-file";
import { isPushSubscription, sendPush } from "./web-push";

export type { BrowserAccessRendererSource } from "./renderer-files";

/** A hidden host window that renders for one browser tab. */
export interface BrowserBridgeWindow {
  isDestroyed(): boolean;
  destroy(): void;
  onClosed(listener: () => void): void;
  /** Whether this window's view has the thread open. */
  showsSession(sessionRef: SessionRef): boolean;
}

export interface BrowserAccessServerOptions {
  /** Interface to listen on. `127.0.0.1` keeps access on this machine. */
  readonly host: string;
  readonly port: number;
  /** The reusable pairing link's secret (readable by this user only). */
  readonly tokenFile: string;
  /** Paired devices, each with its own secret (readable by this user only). */
  readonly devicesFile: string;
  /** The push key pair and browser subscriptions (readable by this user only). */
  readonly pushFile: string;
  /** The bundled browser scripts (out/browser-access). */
  readonly scriptsDir: string;
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
  deviceId: string;
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
/** Closes a tab whose device is not, or no longer, paired; the tab opens the pairing page. */
const CLOSE_NOT_PAIRED = 4003;
const PAIR_PATH = `${BROWSER_ACCESS_PREFIX}/pair`;

async function readToken(tokenFile: string): Promise<string | undefined> {
  const parsed = (await readJsonFile(tokenFile)) as { token?: unknown } | undefined;
  return typeof parsed?.token === "string" && /^[a-f0-9]{64}$/.test(parsed.token)
    ? parsed.token
    : undefined;
}

async function writeNewToken(tokenFile: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await writeSecureJsonFile(tokenFile, { version: 1, token });
  return token;
}

/**
 * Serves pi-gui's renderer to browsers and connects each browser tab to a hidden bridge
 * window on this host. The bridge window loads the real preload, so every request passes
 * through the same IPC handlers, validation and per-window view as a desktop window.
 *
 * Each paired device holds its own secret in an HttpOnly cookie. Every request must name this
 * machine in its Host header, and sockets must come from this origin.
 */
export class BrowserAccessServer {
  private readonly server: http.Server;
  /** Bridge windows reach the host here: loopback only, on its own port. */
  private readonly bridgeServer = http.createServer((request, response) => {
    void this.handleBridgeRequest(request, response).catch((error: unknown) => {
      console.error("[browser-access] bridge request failed", error);
      if (!response.headersSent) sendPlain(response, 500, "Internal error");
    });
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
  private readonly devices: DeviceRegistry;
  private pushQueue: Promise<void> = Promise.resolve();
  private pairingKey = "";
  private boundPort = 0;
  private bridgePort = 0;

  constructor(private readonly options: BrowserAccessServerOptions) {
    this.push = new PushRegistry(options.pushFile);
    this.devices = new DeviceRegistry(options.devicesFile);
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
    const earlierKey = await readToken(this.options.tokenFile);
    const migrated = await this.devices.load(earlierKey);
    // Browsers paired before devices had their own keys hold the old pairing link's key, which
    // now belongs to that one device. The reusable link gets a new key of its own.
    this.pairingKey =
      earlierKey && !migrated ? earlierKey : await writeNewToken(this.options.tokenFile);
    await this.push.load();
    await listen(this.bridgeServer, 0, "127.0.0.1");
    this.bridgePort = boundPort(this.bridgeServer, 0);
    await listen(this.server, this.options.port, this.options.host);
    this.boundPort = boundPort(this.server, this.options.port);
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

  /** Addresses browsers can open, one per network interface. */
  addresses(): string[] {
    const hosts = this.isWildcardHost()
      ? Object.values(os.networkInterfaces())
          .flatMap((infos) => infos ?? [])
          .filter((info) => info.family === "IPv4" && !info.internal)
          .map((info) => info.address)
      : [this.options.host];
    if (hosts.length === 0) hosts.push("127.0.0.1");
    return hosts.map(
      (host) => `${this.scheme}://${host.includes(":") ? `[${host}]` : host}:${this.boundPort}`,
    );
  }

  /** Reusable links that pair a browser. Anyone holding one can use pi-gui as this user. */
  pairingUrls(): string[] {
    return this.addresses().map((address) => `${address}${PAIR_PATH}?token=${this.pairingKey}`);
  }

  status(): BrowserAccessStatus {
    const connected = new Set(
      [...this.tabs.values()].filter((tab) => tab.client).map((tab) => tab.deviceId),
    );
    return {
      enabled: true,
      https: Boolean(this.options.tls),
      addresses: this.addresses(),
      devices: this.devices
        .list()
        .map((device) => ({ ...device, connected: connected.has(device.id) }))
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)),
    };
  }

  /** A one-time code for pairing one more device, with its link and QR code. */
  createPairingCode(): BrowserPairingCode {
    const pending = this.devices.createCode();
    const url = `${this.addresses()[0] ?? ""}${PAIR_PATH}?code=${pending.code}`;
    return {
      code: pending.code,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      url,
      qrSvg: qrSvg(url),
    };
  }

  /** Unpairs a device: its open tabs close, and it gets no more notifications. */
  async revokeDevice(deviceId: string): Promise<BrowserAccessStatus> {
    await this.devices.revoke(deviceId);
    await this.push.removeDevice(deviceId);
    for (const tab of [...this.tabs.values()]) {
      if (tab.deviceId === deviceId) {
        tab.client?.close(CLOSE_NOT_PAIRED, "Revoked");
        this.closeTab(tab);
      }
    }
    return this.status();
  }

  /** Replaces the reusable pairing link. Devices already paired stay paired. */
  async resetPairingLink(): Promise<BrowserAccessStatus> {
    this.pairingKey = await writeNewToken(this.options.tokenFile);
    return this.status();
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

  private get scheme(): "http" | "https" {
    return this.options.tls ? "https" : "http";
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

  private cookieToken(request: IncomingMessage): string | undefined {
    return readCookie(request.headers.cookie, COOKIE_NAME);
  }

  private deviceFor(request: IncomingMessage): string | undefined {
    return this.devices.deviceForToken(this.cookieToken(request));
  }

  private deviceCookie(token: string): string {
    const secure = this.options.tls ? "; Secure" : "";
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`;
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

    if (url.pathname === PAIR_PATH) {
      await this.handlePair(request, response, url);
      return;
    }
    // None of these holds a secret, and a browser fetches them without (or before) pairing.
    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/manifest.webmanifest`) {
      const token = this.cookieToken(request);
      const startUrl = this.devices.deviceForToken(token) ? `${PAIR_PATH}?token=${token}` : "/";
      sendBody(request, response, 200, "application/manifest+json", webAppManifest({ startUrl }));
      return;
    }
    if (url.pathname === BROWSER_ACCESS_SCRIPTS.serviceWorker.path) {
      await this.sendScript(request, response, "serviceWorker", { "Service-Worker-Allowed": "/" });
      return;
    }
    if (url.pathname === BROWSER_ACCESS_SCRIPTS.client.path) {
      await this.sendScript(request, response, "client");
      return;
    }
    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/icon.png` && this.options.iconFile) {
      const icon = await readFile(this.options.iconFile).catch(() => undefined);
      if (!icon) sendPlain(response, 404, "Not found");
      else
        sendBody(request, response, 200, "image/png", icon, { "Cache-Control": "max-age=86400" });
      return;
    }

    if (!this.deviceFor(request)) {
      if (url.pathname === "/" || url.pathname.endsWith(".html")) redirect(response, PAIR_PATH);
      else sendPlain(response, 403, "This browser is not paired with pi-gui.");
      return;
    }
    await serveRenderer(this.options.renderer, request, response, url.pathname, (html) =>
      browserIndexHtml(html, { pushKey: this.push.vapid.publicKey }),
    );
  }

  /**
   * `?code=` pairs a new device with a one-time code. `?token=` accepts a device's own secret
   * (a Home Screen app's start URL) or the reusable pairing link. With neither, an unpaired
   * browser gets the page that asks for a code.
   */
  private async handlePair(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const pairNewDevice = async () => {
      const device = await this.devices.addDevice(request.headers["user-agent"]);
      redirect(response, "/", { "Set-Cookie": this.deviceCookie(device.token) });
    };
    const token = url.searchParams.get("token");
    const code = url.searchParams.get("code");
    if (token) {
      if (this.devices.deviceForToken(token)) {
        redirect(response, "/", { "Set-Cookie": this.deviceCookie(token) });
      } else if (secretsEqual(token, this.pairingKey)) {
        if (this.deviceFor(request)) redirect(response, "/");
        else await pairNewDevice();
      } else {
        this.sendPairingPage(
          request,
          response,
          "That pairing link no longer works. Enter a new code.",
        );
      }
      return;
    }
    if (code) {
      if (this.devices.consumeCode(code)) await pairNewDevice();
      else this.sendPairingPage(request, response, "That code is not valid or has expired.");
      return;
    }
    if (this.deviceFor(request)) redirect(response, "/");
    else this.sendPairingPage(request, response);
  }

  private sendPairingPage(request: IncomingMessage, response: ServerResponse, error?: string) {
    sendBody(
      request,
      response,
      error ? 403 : 200,
      "text/html; charset=utf-8",
      pairingPageHtml(error ? { error } : {}),
    );
  }

  private async sendScript(
    request: IncomingMessage,
    response: ServerResponse,
    script: BrowserAccessScript,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    // Read on every request, so a rebuilt script (development) is served without a restart.
    const file = path.join(this.options.scriptsDir, BROWSER_ACCESS_SCRIPTS[script].file);
    const body = await readFile(file).catch(() => undefined);
    if (!body) {
      sendPlain(response, 500, "The browser access scripts are not built.");
      return;
    }
    sendBody(request, response, 200, "text/javascript; charset=utf-8", body, extraHeaders);
  }

  private isBridgeRequest(request: IncomingMessage): boolean {
    return (
      isLoopbackAddress(request.socket.remoteAddress) &&
      request.headers.host === this.bridgeOrigin()
    );
  }

  private async handleBridgeRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://host.invalid");
    if (request.method !== "GET" || !this.isBridgeRequest(request)) {
      sendPlain(response, 403, "Forbidden");
      return;
    }
    if (url.pathname === BROWSER_ACCESS_SCRIPTS.bridge.path) {
      await this.sendScript(request, response, "bridge");
      return;
    }
    const tab = this.tabs.get(url.searchParams.get("tab") ?? "");
    if (
      url.pathname !== `${BROWSER_ACCESS_PREFIX}/bridge` ||
      !tab ||
      !secretsEqual(url.searchParams.get("key") ?? undefined, tab.secret)
    ) {
      sendPlain(response, 403, "Forbidden");
      return;
    }
    const socketUrl = `ws://${this.bridgeOrigin()}${BROWSER_ACCESS_PREFIX}/bridge-socket?tab=${tab.id}&key=${tab.secret}`;
    sendBody(request, response, 200, "text/html; charset=utf-8", bridgeHtml(socketUrl));
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isAllowedHost(request.headers.host, this.allowedHosts)) {
      rejectUpgrade(socket, 421, "Misdirected Request");
      return;
    }
    if (!isSameOrigin(request.headers.origin, request.headers.host)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const url = new URL(request.url ?? "/", "http://host.invalid");
    if (url.pathname === `${BROWSER_ACCESS_PREFIX}/socket`) {
      this.upgradeClient(request, socket, head, url);
      return;
    }
    if (this.options.renderer.kind === "dev-server" && this.deviceFor(request)) {
      proxyUpgradeToDevServer(request, socket, head, this.options.renderer.url);
      return;
    }
    rejectUpgrade(socket, 404, "Not Found");
  }

  private upgradeClient(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    const tabId = url.searchParams.get("tab") ?? "";
    const instance = url.searchParams.get("instance") ?? "";
    this.clientSockets.handleUpgrade(request, socket, head, (client) => {
      const deviceId = this.deviceFor(request);
      if (!deviceId) {
        client.close(CLOSE_NOT_PAIRED, "Not paired");
        return;
      }
      if (!ID_PATTERN.test(tabId) || !ID_PATTERN.test(instance)) {
        client.close(4000, "Bad request");
        return;
      }
      this.devices.markSeen(deviceId);
      this.attachClient(tabId, instance, deviceId, client);
    });
  }

  private attachClient(tabId: string, instance: string, deviceId: string, client: WebSocket) {
    let tab = this.tabs.get(tabId);
    if (tab && (tab.window.isDestroyed() || tab.deviceId !== deviceId)) {
      // A tab id belongs to one device; another device's tab with the same id starts fresh.
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
      tab = this.openTab(tabId, deviceId);
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

    client.on("message", (data) => this.handleClientMessage(record, client, rawText(data)));
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

  /**
   * Calls go to the bridge, which validates the member and its arguments. The host answers
   * host calls and visibility reports itself.
   */
  private handleClientMessage(tab: TabRecord, client: WebSocket, text: string): void {
    let frame: { t?: unknown; id?: unknown; m?: unknown; a?: unknown; visible?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return;
    }
    if (frame.t === "call" && tab.bridge?.readyState === WebSocket.OPEN) {
      tab.bridge.send(text);
    } else if (frame.t === "visibility" && typeof frame.visible === "boolean") {
      tab.visible = frame.visible;
    } else if (frame.t === "host" && typeof frame.id === "number") {
      const id = frame.id;
      const reply = (result: object) => {
        if (client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify({ t: "result", id, ...result }));
      };
      this.handleHostCall(tab.deviceId, frame.m, frame.a).then(
        (value) => reply({ ok: true, v: value }),
        (error: unknown) =>
          reply({ ok: false, e: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  private async handleHostCall(deviceId: string, member: unknown, args: unknown): Promise<unknown> {
    const first = Array.isArray(args) ? (args[0] as unknown) : undefined;
    if (member === "pushSubscribe") {
      if (!isPushSubscription(first)) throw new Error("That push subscription is not valid.");
      await this.push.add(first, deviceId);
      return true;
    }
    if (member === "pushUnsubscribe") {
      if (typeof first !== "string") throw new Error("An endpoint is required.");
      await this.push.remove(first);
      return true;
    }
    if (member === "resolveFolder") return resolveFolder(first);
    throw new Error("Unknown request.");
  }

  private announceReady(tab: TabRecord): void {
    if (tab.client?.readyState === WebSocket.OPEN) {
      tab.client.send(JSON.stringify({ t: "ready", resumed: tab.resumed }));
    }
  }

  private openTab(tabId: string, deviceId: string): TabRecord {
    const secret = randomBytes(32).toString("hex");
    const url = `http://${this.bridgeOrigin()}${BROWSER_ACCESS_PREFIX}/bridge?tab=${tabId}&key=${secret}`;
    // The window loads the bridge page asynchronously, after the record below is registered.
    const window = this.options.openBridgeWindow(url);
    const record: TabRecord = {
      id: tabId,
      secret,
      deviceId,
      resumed: false,
      visible: false,
      window,
    };
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
}

/** A browser has no folder picker for the host, so it sends a typed path to check. */
async function resolveFolder(typed: unknown): Promise<string> {
  if (typeof typed !== "string" || typed.trim().length === 0)
    throw new Error("Enter a folder path.");
  const entered = typed.trim();
  const expanded =
    entered === "~" || entered.startsWith("~/")
      ? path.join(os.homedir(), entered.slice(1))
      : entered;
  if (!path.isAbsolute(expanded)) throw new Error("Enter a full path, such as ~/src/my-project.");
  const info = await stat(expanded).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`There is no folder at ${entered}.`);
  return path.resolve(expanded);
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function boundPort(server: http.Server, fallback: number): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : fallback;
}
