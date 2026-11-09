import {
  BROWSER_ACCESS_PREFIX,
  browserAccessBlockedMembers,
  browserAccessCallMembers,
  browserAccessEventMembers,
} from "../../contracts/browser-access";

/**
 * Scripts the host serves to browsers. They are plain JavaScript strings, not bundled
 * functions, so a bundler cannot inject helpers that would be undefined in the page.
 */

const sharedConfig = JSON.stringify({
  prefix: BROWSER_ACCESS_PREFIX,
  call: browserAccessCallMembers,
  event: browserAccessEventMembers,
  blocked: browserAccessBlockedMembers,
});

/**
 * Runs in the browser tab before the renderer bundle. It installs `window.piApp` with the
 * same members as the desktop preload. Calls and events travel over one WebSocket to the
 * tab's bridge window on the host; members that only make sense on the host's own screen
 * are answered locally or rejected.
 */
export const browserClientScript = `(() => {
  "use strict";
  const config = ${sharedConfig};
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
  const send = (frame) => {
    if (ready && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    else outbox.push(frame);
  };
  // JSON turns an undefined argument into null, which the host's validators reject, so
  // undefined arguments travel as a marker.
  const UNDEFINED = { __piUndefined: true };
  const encodeArgs = (args) => args.map((arg) => (arg === undefined ? UNDEFINED : arg));
  const decodeArgs = (args) => args.map((arg) => (arg && typeof arg === "object" && arg.__piUndefined === true ? undefined : arg));
  const call = (member, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ t: "call", id, m: member, a: encodeArgs(args) });
  });

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
        for (const queued of outbox.splice(0)) ws.send(JSON.stringify(queued));
        if (resuming) resync();
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

  const ua = navigator.userAgent;
  const platform = /Mac|iPhone|iPad|iPod/.test(ua) ? "darwin" : /Windows/.test(ua) ? "win32" : "linux";
  const unavailable = (member) => () => Promise.reject(new Error(member + " is not available in the browser."));

  const api = {
    platform,
    drawsWindowControls: false,
    versions: {},
    getPathForFile: () => "",
    readClipboardImage: () => ({ ok: false }),
    getNotificationPermissionStatus: () => Promise.resolve("unsupported"),
    requestNotificationPermission: () => Promise.resolve("unsupported"),
    onNotificationPermissionStatusChanged: () => () => {},
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

/**
 * Runs in a hidden bridge window on the host, next to the real preload. It invokes only
 * members whose policy is `call`, and forwards every `event` member back to the browser.
 */
export function bridgeScript(socketUrl: string): string {
  return `(() => {
  "use strict";
  const config = ${sharedConfig};
  const allowed = new Set(config.call);
  const api = window.piApp;
  const outbox = [];
  const UNDEFINED = { __piUndefined: true };
  const encodeArgs = (args) => args.map((arg) => (arg === undefined ? UNDEFINED : arg));
  const decodeArgs = (args) => args.map((arg) => (arg && typeof arg === "object" && arg.__piUndefined === true ? undefined : arg));
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
