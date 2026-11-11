/**
 * Runs in a paired browser tab before the renderer bundle. It installs `window.piApp` with the
 * same members as the desktop preload. Calls and events travel over one WebSocket to the tab's
 * bridge window on the host; members that only make sense on the host's own screen are
 * answered here or rejected. Notifications use Web Push through a service worker.
 *
 * The host serves this file with the push key on the script tag (`data-push-key`).
 */
import {
  BROWSER_ACCESS_PREFIX,
  browserAccessBlockedMembers,
  browserAccessCallMembers,
  browserAccessEventMembers,
} from "../../contracts/browser-access";
import type { DesktopNotificationPermissionStatus, PiDesktopApi } from "../../contracts/ipc";
import type { ComposerImageAttachment, DesktopAppState } from "../../contracts/desktop-state";
import { decodeArgs, encodeArgs, errorMessage, parseFrame } from "./codec";

type Listener = (...payload: unknown[]) => void;
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}
interface SessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

const TAB_KEY = "pi-browser-tab";
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Closed by the host because this browser is not (or no longer) paired. */
const CLOSE_NOT_PAIRED = 4003;
/** Closed because another tab holds this tab id (a duplicated tab shares sessionStorage). */
const CLOSE_TAB_IN_USE = 4001;

const pushPublicKey = document.currentScript?.dataset.pushKey ?? "";

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let tabId = sessionStorage.getItem(TAB_KEY) ?? randomId();
sessionStorage.setItem(TAB_KEY, tabId);
const instanceId = randomId();

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<number, Pending>();
const outbox: object[] = [];
let socket: WebSocket | null = null;
let ready = false;
let attachedOnce = false;
let nextId = 1;
let retryDelay = 250;

function emit(member: string, payload: readonly unknown[]): void {
  for (const listener of listeners.get(member) ?? []) {
    try {
      listener(...payload);
    } catch (error) {
      console.error("[pi-browser] listener failed", member, error);
    }
  }
}

function subscribe(member: string) {
  return (listener: Listener) => {
    let set = listeners.get(member);
    if (!set) {
      set = new Set();
      listeners.set(member, set);
    }
    set.add(listener);
    return () => {
      listeners.get(member)?.delete(listener);
    };
  };
}

function sendNow(frame: object): boolean {
  if (ready && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
    return true;
  }
  return false;
}

function send(frame: object): void {
  if (!sendNow(frame)) outbox.push(frame);
}

function request(type: "call" | "host", member: string, args: readonly unknown[]) {
  return new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ t: type, id, m: member, a: encodeArgs(args) });
  });
}

const call = (member: string, args: readonly unknown[]) => request("call", member, args);
const hostCall = (member: string, args: readonly unknown[]) => request("host", member, args);
const getState = () => call("getState", []) as Promise<DesktopAppState>;

function reportVisibility(): void {
  sendNow({ t: "visibility", visible: document.visibilityState === "visible" });
}

function resync(): void {
  getState()
    .then((state) => emit("onStateChanged", [state]))
    .catch(() => undefined);
  call("resendSelectedTranscript", []).catch(() => undefined);
}

function connect(): void {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${location.host}${BROWSER_ACCESS_PREFIX}/socket?tab=${tabId}&instance=${instanceId}`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onmessage = (message: MessageEvent<unknown>) => {
    const frame = parseFrame(message.data);
    if (!frame) return;
    if (frame.t === "ready") {
      if (attachedOnce && frame.resumed !== true) {
        // The host no longer has this tab's window, so its view is gone. Start over.
        location.reload();
        return;
      }
      const resuming = attachedOnce;
      attachedOnce = true;
      ready = true;
      retryDelay = 250;
      reportVisibility();
      for (const queued of outbox.splice(0)) ws.send(JSON.stringify(queued));
      if (resuming) resync();
      else onFirstReady();
    } else if (frame.t === "result" && typeof frame.id === "number") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.ok === true) entry.resolve(frame.v);
      else entry.reject(new Error(typeof frame.e === "string" ? frame.e : "Request failed"));
    } else if (frame.t === "event" && typeof frame.m === "string" && Array.isArray(frame.p)) {
      emit(frame.m, decodeArgs(frame.p as unknown[]));
    }
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    ready = false;
    socket = null;
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error("The connection to pi-gui was lost."));
    }
    if (event.code === CLOSE_TAB_IN_USE) {
      tabId = randomId();
      sessionStorage.setItem(TAB_KEY, tabId);
      attachedOnce = false;
    }
    if (event.code === CLOSE_NOT_PAIRED) {
      location.assign(`${BROWSER_ACCESS_PREFIX}/pair`);
      return;
    }
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5000);
  };
}

// ---------------------------------------------------------------------------------------------
// Notifications (Web Push). iOS offers push only in a web app added to the Home Screen.

const pushSupported = () =>
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

const permissionListeners = new Set<(status: DesktopNotificationPermissionStatus) => void>();
const workerRegistration: Promise<ServiceWorkerRegistration | null> = pushSupported()
  ? navigator.serviceWorker
      .register(`${BROWSER_ACCESS_PREFIX}/sw.js`, { scope: "/" })
      .catch((error: unknown) => {
        console.error("[pi-browser] service worker registration failed", error);
        return null;
      })
  : Promise.resolve(null);

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function permissionStatus(): DesktopNotificationPermissionStatus {
  if (!pushSupported()) return "unsupported";
  return Notification.permission === "granted" || Notification.permission === "denied"
    ? Notification.permission
    : "default";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function syncSubscription(): Promise<void> {
  const registration = await workerRegistration;
  if (!registration || Notification.permission !== "granted" || !pushPublicKey) return;
  await navigator.serviceWorker.ready;
  const expected = keyBytes(pushPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && !sameBytes(new Uint8Array(current), expected)) {
    // The host has a new key pair, so the old subscription can no longer be used.
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: expected,
  });
  await hostCall("pushSubscribe", [subscription.toJSON()]);
}

function isSessionTarget(value: unknown): value is SessionTarget {
  const candidate = value as Partial<SessionTarget> | null;
  return typeof candidate?.workspaceId === "string" && typeof candidate.sessionId === "string";
}

function openSession(session: unknown): void {
  if (!isSessionTarget(session)) return;
  call("selectSession", [{ workspaceId: session.workspaceId, sessionId: session.sessionId }]).catch(
    (error: unknown) =>
      console.error("[pi-browser] could not open the notification's thread", error),
  );
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data as { type?: unknown; session?: unknown } | null;
    if (data?.type === "pi-open-session") openSession(data.session);
  });
}

function onFirstReady(): void {
  const match = /^#pi-session=(.+)$/.exec(location.hash);
  if (match?.[1]) {
    history.replaceState(null, "", location.pathname + location.search);
    try {
      openSession(JSON.parse(decodeURIComponent(match[1])));
    } catch {
      // A malformed link opens the app without selecting a thread.
    }
  }
  syncSubscription().catch((error: unknown) =>
    console.error("[pi-browser] push subscription failed", error),
  );
}

// ---------------------------------------------------------------------------------------------
// Layout: iOS Safari shrinks the visual viewport for the keyboard and scrolls the page, which
// pushes the composer out of view. The app sizes itself to the visual viewport instead.

document.documentElement.dataset.piSurface = "browser";
const viewport = window.visualViewport;
function fitViewport(): void {
  const height = viewport ? viewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--pi-viewport-height", `${Math.round(height)}px`);
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
}
fitViewport();
(viewport ?? window).addEventListener("resize", fitViewport);
viewport?.addEventListener("scroll", fitViewport);

// ---------------------------------------------------------------------------------------------
// Pickers: the host has no screen for its native pickers here, so the browser asks instead.

async function pickWorkspace(): Promise<DesktopAppState> {
  const answer = window.prompt(
    "Folder on the host computer to open (for example ~/src/my-project):",
    "",
  );
  const entered = answer?.trim() ?? "";
  if (!entered) return getState();
  try {
    const folder = await hostCall("resolveFolder", [entered]);
    return (await call("addWorkspacePath", [folder])) as DesktopAppState;
  } catch (error) {
    window.alert(errorMessage(error));
    return getState();
  }
}

function readImage(file: File): Promise<ComposerImageAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(
        comma === -1
          ? null
          : ({
              id: crypto.randomUUID(),
              kind: "image",
              name: file.name || "photo.jpg",
              mimeType: file.type as ComposerImageAttachment["mimeType"],
              data: result.slice(comma + 1),
            } satisfies ComposerImageAttachment),
      );
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Files on this device have no path on the host, so only images (sent as data) attach. */
function pickComposerAttachments(): Promise<DesktopAppState> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = IMAGE_TYPES.join(",");
    input.style.display = "none";
    let settled = false;
    const finish = (result: Promise<DesktopAppState>) => {
      if (settled) return;
      settled = true;
      input.remove();
      result.then(resolve, reject);
    };
    input.addEventListener("cancel", () => finish(getState()));
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (files.some((file) => file.size > MAX_IMAGE_BYTES)) {
        window.alert("Images must be 10 MB or smaller.");
      }
      const images = files.filter(
        (file) => IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE_BYTES,
      );
      finish(
        Promise.all(images.map(readImage)).then((read) => {
          const attachments = read.filter((entry): entry is ComposerImageAttachment => !!entry);
          return attachments.length > 0
            ? (call("addComposerAttachments", [attachments]) as Promise<DesktopAppState>)
            : getState();
        }),
      );
    });
    document.body.appendChild(input);
    // Must run inside the tap that asked for it, or the browser refuses to show the picker.
    input.click();
  });
}

// ---------------------------------------------------------------------------------------------

const ua = navigator.userAgent;
const platform: NodeJS.Platform = /Mac|iPhone|iPad|iPod/.test(ua)
  ? "darwin"
  : /Windows/.test(ua)
    ? "win32"
    : "linux";

const api: Record<string, unknown> = {
  platform,
  surface: "browser",
  drawsWindowControls: false,
  versions: {},
  pickWorkspace,
  pickComposerAttachments,
  getPathForFile: () => "",
  readClipboardImage: () => ({ ok: false }),
  getNotificationPermissionStatus: () => Promise.resolve(permissionStatus()),
  requestNotificationPermission: async () => {
    if (!pushSupported()) return "unsupported";
    // Safari grants permission only from a tap, so ask before anything else is awaited.
    const result = await Notification.requestPermission();
    if (result === "granted") await syncSubscription();
    const status = permissionStatus();
    for (const listener of permissionListeners) listener(status);
    return status;
  },
  onNotificationPermissionStatusChanged: (
    listener: (status: DesktopNotificationPermissionStatus) => void,
  ) => {
    permissionListeners.add(listener);
    return () => {
      permissionListeners.delete(listener);
    };
  },
  onPendingComposerDraftFlush: () => () => undefined,
  onExtensionViewOpenFile: () => () => undefined,
  onExtensionViewMessage: () => () => undefined,
  onExtensionViewCatalogChanged: () => () => undefined,
  listExtensionViews: () => Promise.resolve([]),
  closeExtensionView: () => Promise.resolve(),
  toggleWindowMaximize: () => Promise.resolve(),
  minimizeWindow: () => undefined,
  closeWindow: () => undefined,
  openExternal: (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        window.open(parsed.href, "_blank", "noopener,noreferrer");
      }
    } catch {
      // Not a URL: nothing to open.
    }
    return Promise.resolve();
  },
  onWindowFocused: (listener: () => void) => {
    window.addEventListener("focus", listener);
    return () => window.removeEventListener("focus", listener);
  },
};
for (const member of browserAccessCallMembers) {
  api[member] = (...args: unknown[]) => call(member, args);
}
for (const member of browserAccessEventMembers) api[member] = subscribe(member);
for (const member of browserAccessBlockedMembers) {
  api[member] = () => Promise.reject(new Error(`${member} is not available in the browser.`));
}
// These return nothing on the desktop, so their failures are not the caller's concern.
api.resendSelectedTranscript = () => {
  call("resendSelectedTranscript", []).catch(() => undefined);
};
for (const member of ["setTerminalFocused", "setSidePanelFocused"] as const) {
  api[member] = (...args: unknown[]) => call(member, args).catch(() => undefined);
}

document.addEventListener("visibilitychange", reportVisibility);
window.piApp = Object.freeze(api) as unknown as PiDesktopApi;
connect();
