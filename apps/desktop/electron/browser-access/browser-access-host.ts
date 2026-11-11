import { BrowserWindow } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionRef } from "@pi-gui/session-driver";
import { desktopIpc } from "../../contracts/ipc";
import type { BrowserAccessStatus } from "../../contracts/browser-access";
import { mainFrameHandler } from "../ipc/main-frame-ipc";
import { expectNonEmptyString } from "../ipc/request-validation";
import type { ThemeManager } from "../platform/theme-manager";
import type { WindowOwner } from "../windows/window-owner";
import { parseBrowserAccessConfig } from "./browser-access-config";
import {
  BrowserAccessServer,
  type BrowserAccessRendererSource,
  type BrowserBridgeWindow,
} from "./browser-access-server";

export interface BrowserAccessHostOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataDir: string;
  readonly preloadPath: string;
  readonly renderer: BrowserAccessRendererSource;
  /** The bundled browser scripts (out/browser-access). */
  readonly scriptsDir: string;
  readonly iconFile: string;
  readonly windowOwner: WindowOwner;
  readonly themeManager: ThemeManager;
  /** Ends the terminals a closed bridge window opened. */
  readonly disposeTerminals: (webContentsId: number) => void;
}

const BROWSER_ACCESS_OFF: BrowserAccessStatus = { enabled: false };

/**
 * Everything browser access adds to the desktop app: the server (when PI_APP_BROWSER_ACCESS
 * turns it on), the hidden bridge windows it opens, and the Settings page's IPC requests.
 * The rest of the app reaches it through `notify`.
 */
export class BrowserAccessHost {
  private server: BrowserAccessServer | undefined;

  constructor(private readonly options: BrowserAccessHostOptions) {}

  /** Registers the IPC requests, whether or not browser access is on. Call once. */
  registerIpc(): void {
    const handle = mainFrameHandler(this.options.windowOwner);
    const none = () => undefined;
    handle(
      desktopIpc.getBrowserAccessStatus,
      none,
      () => this.server?.status() ?? BROWSER_ACCESS_OFF,
    );
    handle(desktopIpc.createBrowserPairingCode, none, () =>
      this.requireServer().createPairingCode(),
    );
    handle(
      desktopIpc.revokeBrowserDevice,
      (raw) => expectNonEmptyString(raw, "deviceId"),
      (deviceId) => this.requireServer().revokeDevice(deviceId),
    );
    handle(desktopIpc.resetBrowserPairingLink, none, () => this.requireServer().resetPairingLink());
  }

  async start(): Promise<void> {
    const config = parseBrowserAccessConfig(this.options.env);
    if (!config) return;
    const tls = config.tls
      ? { cert: await readFile(config.tls.certFile), key: await readFile(config.tls.keyFile) }
      : undefined;
    const { userDataDir } = this.options;
    const server = new BrowserAccessServer({
      host: config.host,
      port: config.port,
      extraHostnames: config.extraHostnames,
      tokenFile: path.join(userDataDir, "browser-access.json"),
      devicesFile: path.join(userDataDir, "browser-devices.json"),
      pushFile: path.join(userDataDir, "browser-push.json"),
      scriptsDir: this.options.scriptsDir,
      pushContact: config.pushContact,
      iconFile: this.options.iconFile,
      ...(tls ? { tls } : {}),
      renderer: this.options.renderer,
      openBridgeWindow: (url) => this.openBridgeWindow(url),
    });
    await server.start();
    this.server = server;
    console.log("[main] Browser access is on. Open a pairing link in a browser:");
    for (const url of server.pairingUrls()) console.log(`  ${url}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.stop();
  }

  notify(sessionRef: SessionRef, title: string, body: string): void {
    this.server?.notify(sessionRef, title, body);
  }

  private requireServer(): BrowserAccessServer {
    if (!this.server) throw new Error("Browser access is off.");
    return this.server;
  }

  /**
   * A hidden window that renders for one browser tab. It loads the real preload, so the tab's
   * requests use the same IPC handlers and per-window view as a desktop window. It never
   * navigates and never becomes the active window.
   */
  private openBridgeWindow(url: string): BrowserBridgeWindow {
    const { windowOwner, themeManager } = this.options;
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const webContentsId = window.webContents.id;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame) event.preventDefault();
    });
    windowOwner.add(window, windowOwner.foregroundView(), { remote: true });
    themeManager.trackWindow(window);
    window.once("closed", () => {
      windowOwner.remove(window);
      this.options.disposeTerminals(webContentsId);
    });
    window.loadURL(url).catch((error: unknown) => {
      console.error("[browser-access] bridge window failed to load", error);
      if (!window.isDestroyed()) window.destroy();
    });
    return {
      isDestroyed: () => window.isDestroyed(),
      destroy: () => window.destroy(),
      onClosed: (listener) => window.once("closed", listener),
      showsSession: (sessionRef) => {
        if (window.isDestroyed()) return false;
        const view = windowOwner.viewForWindow(window);
        return (
          view.activeView === "threads" &&
          view.selectedWorkspaceId === sessionRef.workspaceId &&
          view.selectedSessionId === sessionRef.sessionId
        );
      },
    };
  }
}
