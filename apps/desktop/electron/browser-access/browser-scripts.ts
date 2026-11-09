import {
  BROWSER_ACCESS_PREFIX,
  browserAccessBlockedMembers,
  browserAccessCallMembers,
  browserAccessEventMembers,
} from "../../contracts/browser-access";

/**
 * Scripts and documents the host serves to browsers. Scripts are plain JavaScript strings,
 * not bundled functions, so a bundler cannot inject helpers that would be undefined in the
 * page.
 */

const sharedConfig = {
  prefix: BROWSER_ACCESS_PREFIX,
  call: browserAccessCallMembers,
  event: browserAccessEventMembers,
  blocked: browserAccessBlockedMembers,
};

/** JSON turns undefined arguments into null, which IPC validators reject; this keeps them. */
const argumentCodec = `
  const UNDEFINED = { __piUndefined: true };
  const encodeArgs = (args) => args.map((arg) => (arg === undefined ? UNDEFINED : arg));
  const decodeArgs = (args) => args.map((arg) => (arg && typeof arg === "object" && arg.__piUndefined === true ? undefined : arg));
`;

/**
 * Runs in the browser tab before the renderer bundle. It installs `window.piApp` with the
 * same members as the desktop preload. Calls and events travel over one WebSocket to the
 * tab's bridge window on the host; members that only make sense on the host's own screen
 * are answered locally or rejected. Notifications use Web Push through a service worker.
 */
export function browserClientScript(options: { readonly pushPublicKey: string }): string {
  const config = JSON.stringify({ ...sharedConfig, pushPublicKey: options.pushPublicKey });
  return `(() => {
  "use strict";
  const config = ${config};
  ${argumentCodec}
  const TAB_KEY = "pi-browser-tab";
  const randomId = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  let tabId = sessionStorage.getItem(TAB_KEY) || randomId();
  sessionStorage.setItem(TAB_KEY, tabId);
  const instanceId = randomId();

  const listeners = new Map();
  const pending = new Map();
  const outbox = [];
  let socket = null;
  let ready = false;
  let attachedOnce = false;
  let nextId = 1;
  let retryDelay = 250;

  const emit = (member, payload) => {
    for (const listener of listeners.get(member) ?? []) {
      try { listener(...payload); } catch (error) { console.error("[pi-browser] listener failed", member, error); }
    }
  };
  const subscribe = (member) => (listener) => {
    if (!listeners.has(member)) listeners.set(member, new Set());
    listeners.get(member).add(listener);
    return () => listeners.get(member)?.delete(listener);
  };
  const sendNow = (frame) => {
    if (ready && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
      return true;
    }
    return false;
  };
  const send = (frame) => { if (!sendNow(frame)) outbox.push(frame); };
  const request = (type, member, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ t: type, id, m: member, a: encodeArgs(args) });
  });
  const call = (member, args) => request("call", member, args);
  const hostCall = (member, args) => request("host", member, args);
  const reportVisibility = () => sendNow({ t: "visibility", visible: document.visibilityState === "visible" });

  const resync = () => {
    call("getState", []).then((state) => emit("onStateChanged", [state])).catch(() => {});
    call("resendSelectedTranscript", []).catch(() => {});
  };

  const connect = () => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const url = scheme + "//" + location.host + config.prefix + "/socket?tab=" + tabId + "&instance=" + instanceId;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onmessage = (message) => {
      let frame;
      try { frame = JSON.parse(message.data); } catch { return; }
      if (frame.t === "ready") {
        if (attachedOnce && !frame.resumed) {
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
      } else if (frame.t === "result") {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        if (frame.ok) entry.resolve(frame.v);
        else entry.reject(new Error(frame.e || "Request failed"));
      } else if (frame.t === "event") {
        emit(frame.m, decodeArgs(frame.p));
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
      if (event.code === 4001) {
        // Another tab (a duplicated one shares sessionStorage) holds this id.
        tabId = randomId();
        sessionStorage.setItem(TAB_KEY, tabId);
        attachedOnce = false;
      }
      if (event.code === 4003) {
        document.body.textContent = "This browser is not paired with pi-gui. Open the pairing link again.";
        return;
      }
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    };
  };
  document.addEventListener("visibilitychange", reportVisibility);

  // Notifications: Web Push through a service worker. iOS offers it only in a web app added
  // to the Home Screen, so elsewhere the status is "unsupported".
  const pushSupported = () =>
    window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const permissionListeners = new Set();
  const workerRegistration = pushSupported()
    ? navigator.serviceWorker.register(config.prefix + "/sw.js", { scope: "/" }).catch((error) => {
        console.error("[pi-browser] service worker registration failed", error);
        return null;
      })
    : Promise.resolve(null);
  const keyBytes = (base64url) => {
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((base64url.length + 3) % 4);
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  };
  const permissionStatus = () => {
    if (!pushSupported()) return "unsupported";
    return Notification.permission === "granted" || Notification.permission === "denied" ? Notification.permission : "default";
  };
  const syncSubscription = async () => {
    const registration = await workerRegistration;
    if (!registration || Notification.permission !== "granted") return;
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    const current = subscription?.options?.applicationServerKey;
    if (subscription && current) {
      const expected = keyBytes(config.pushPublicKey);
      const actual = new Uint8Array(current);
      if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) {
        // The host has a new key pair, so the old subscription can no longer be used.
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(config.pushPublicKey),
      });
    }
    await hostCall("pushSubscribe", [subscription.toJSON()]);
  };
  const notifyPermission = (status) => {
    for (const listener of permissionListeners) {
      try { listener(status); } catch (error) { console.error("[pi-browser] permission listener failed", error); }
    }
  };

  const openSession = (session) => {
    if (!session || typeof session.workspaceId !== "string" || typeof session.sessionId !== "string") return;
    call("selectSession", [{ workspaceId: session.workspaceId, sessionId: session.sessionId }]).catch((error) => {
      console.error("[pi-browser] could not open the notification's thread", error);
    });
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "pi-open-session") openSession(event.data.session);
    });
  }
  const onFirstReady = () => {
    const match = /^#pi-session=(.+)$/.exec(location.hash);
    if (match) {
      history.replaceState(null, "", location.pathname + location.search);
      try { openSession(JSON.parse(decodeURIComponent(match[1]))); } catch {}
    }
    syncSubscription().catch((error) => console.error("[pi-browser] push subscription failed", error));
  };

  const ua = navigator.userAgent;
  const platform = /Mac|iPhone|iPad|iPod/.test(ua) ? "darwin" : /Windows/.test(ua) ? "win32" : "linux";
  const unavailable = (member) => () => Promise.reject(new Error(member + " is not available in the browser."));

  const api = {
    platform,
    drawsWindowControls: false,
    versions: {},
    getPathForFile: () => "",
    readClipboardImage: () => ({ ok: false }),
    getNotificationPermissionStatus: () => Promise.resolve(permissionStatus()),
    requestNotificationPermission: () => {
      if (!pushSupported()) return Promise.resolve("unsupported");
      // Safari grants permission only from a tap, so ask before anything is awaited.
      return Notification.requestPermission().then(async (result) => {
        const status = permissionStatus();
        if (result === "granted") await syncSubscription();
        notifyPermission(status);
        return status;
      });
    },
    onNotificationPermissionStatusChanged: (listener) => {
      permissionListeners.add(listener);
      return () => permissionListeners.delete(listener);
    },
    onPendingComposerDraftFlush: () => () => {},
    onExtensionViewOpenFile: () => () => {},
    onExtensionViewMessage: () => () => {},
    onExtensionViewCatalogChanged: () => () => {},
    listExtensionViews: () => Promise.resolve([]),
    closeExtensionView: () => Promise.resolve(),
    toggleWindowMaximize: () => Promise.resolve(),
    minimizeWindow: () => {},
    closeWindow: () => {},
    openExternal: (url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") window.open(parsed.href, "_blank", "noopener,noreferrer");
      } catch {}
      return Promise.resolve();
    },
    onWindowFocused: (listener) => {
      window.addEventListener("focus", listener);
      return () => window.removeEventListener("focus", listener);
    },
  };
  for (const member of config.call) api[member] = (...args) => call(member, args);
  for (const member of config.event) api[member] = subscribe(member);
  for (const member of config.blocked) api[member] = unavailable(member);
  // These return nothing on the desktop, so their failures are not the caller's concern.
  for (const member of ["resendSelectedTranscript", "setTerminalFocused", "setSidePanelFocused"]) {
    const forward = api[member];
    api[member] = (...args) => { const result = forward(...args); result.catch(() => {}); return member === "resendSelectedTranscript" ? undefined : result; };
  }

  window.piApp = Object.freeze(api);
  connect();
})();
`;
}

/**
 * Service worker for the browser app: shows each push as a notification and opens its
 * thread when the notification is tapped. It never intercepts requests.
 */
export const serviceWorkerScript = `"use strict";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = typeof data.title === "string" && data.title ? data.title : "pi";
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    icon: ${JSON.stringify(`${BROWSER_ACCESS_PREFIX}/icon.png`)},
    data: { session: data.session },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const session = event.notification.data && event.notification.data.session;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.focus();
        if (session) client.postMessage({ type: "pi-open-session", session });
        return;
      }
    }
    const hash = session ? "#pi-session=" + encodeURIComponent(JSON.stringify(session)) : "";
    await self.clients.openWindow("/" + hash);
  })());
});
`;

/**
 * Web app manifest. A paired browser gets the pairing link as its start URL: on iOS a Home
 * Screen app keeps its own cookies, so launching it pairs it again.
 */
export function webAppManifest(options: { readonly startUrl: string }): string {
  return JSON.stringify({
    name: "pi",
    short_name: "pi",
    start_url: options.startUrl,
    scope: "/",
    display: "standalone",
    background_color: "#1b1b1b",
    theme_color: "#1b1b1b",
    icons: [
      {
        src: `${BROWSER_ACCESS_PREFIX}/icon.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  });
}

/** Tags added to the renderer's `<head>` for browsers. */
export const browserHeadTags = [
  `<script src="${BROWSER_ACCESS_PREFIX}/client.js"></script>`,
  `<link rel="manifest" href="${BROWSER_ACCESS_PREFIX}/manifest.webmanifest" crossorigin="use-credentials">`,
  `<link rel="apple-touch-icon" href="${BROWSER_ACCESS_PREFIX}/icon.png">`,
  `<meta name="apple-mobile-web-app-capable" content="yes">`,
  `<meta name="mobile-web-app-capable" content="yes">`,
  `<meta name="apple-mobile-web-app-title" content="pi">`,
  `<meta name="apple-mobile-web-app-status-bar-style" content="black">`,
].join("");

/**
 * Runs in a hidden bridge window on the host, next to the real preload. It invokes only
 * members whose policy is `call`, and forwards every `event` member back to the browser.
 */
export function bridgeScript(socketUrl: string): string {
  return `(() => {
  "use strict";
  const config = ${JSON.stringify(sharedConfig)};
  const allowed = new Set(config.call);
  const api = window.piApp;
  const outbox = [];
  ${argumentCodec}
  const socket = new WebSocket(${JSON.stringify(socketUrl)});
  const send = (frame) => {
    let text;
    try { text = JSON.stringify(frame); } catch (error) {
      if (frame.t === "result") text = JSON.stringify({ t: "result", id: frame.id, ok: false, e: "The result could not be sent to the browser." });
      else return;
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(text);
    else if (socket.readyState === WebSocket.CONNECTING) outbox.push(text);
  };
  socket.onopen = () => { for (const text of outbox.splice(0)) socket.send(text); };
  for (const member of config.event) {
    api[member]((...payload) => send({ t: "event", m: member, p: encodeArgs(payload) }));
  }
  socket.onmessage = async (message) => {
    let frame;
    try { frame = JSON.parse(message.data); } catch { return; }
    if (frame.t !== "call" || typeof frame.id !== "number" || !Array.isArray(frame.a)) return;
    if (!allowed.has(frame.m)) {
      send({ t: "result", id: frame.id, ok: false, e: frame.m + " is not available in the browser." });
      return;
    }
    try {
      const value = await api[frame.m](...decodeArgs(frame.a));
      send({ t: "result", id: frame.id, ok: true, v: value });
    } catch (error) {
      send({ t: "result", id: frame.id, ok: false, e: error instanceof Error ? error.message : String(error) });
    }
  };
})();
`;
}
