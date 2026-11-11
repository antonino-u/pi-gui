/**
 * Service worker for the browser app: shows each push as a notification and opens its thread
 * when the notification is tapped. It never intercepts requests.
 *
 * The renderer's TypeScript project uses the DOM library, which cannot be combined with the
 * WebWorker one, so the few worker types used here are declared locally.
 */
import { BROWSER_ACCESS_PREFIX } from "../../contracts/browser-access";

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushEventLike extends ExtendableEventLike {
  readonly data: { json(): unknown } | null;
}
interface NotificationEventLike extends ExtendableEventLike {
  readonly notification: { close(): void; readonly data: unknown };
}
interface WindowClientLike {
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
interface ServiceWorkerScopeLike {
  skipWaiting(): Promise<void>;
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options: {
      type: "window";
      includeUncontrolled: boolean;
    }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  readonly registration: {
    showNotification(title: string, options: Record<string, unknown>): Promise<void>;
  };
  addEventListener(
    type: "install" | "activate",
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: NotificationEventLike) => void,
  ): void;
}

interface PushPayload {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly tag?: unknown;
  readonly session?: unknown;
}

const worker = globalThis as unknown as ServiceWorkerScopeLike;

worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

worker.addEventListener("push", (event) => {
  let data: PushPayload = {};
  try {
    data = (event.data?.json() ?? {}) as PushPayload;
  } catch {
    // An unreadable payload still shows a notification, which iOS requires for every push.
  }
  const title = typeof data.title === "string" && data.title ? data.title : "pi";
  event.waitUntil(
    worker.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: `${BROWSER_ACCESS_PREFIX}/icon.png`,
      data: { session: data.session },
    }),
  );
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const session = (event.notification.data as { session?: unknown } | null)?.session;
  event.waitUntil(
    (async () => {
      const [client] = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (client) {
        await client.focus();
        if (session) client.postMessage({ type: "pi-open-session", session });
        return;
      }
      const hash = session ? `#pi-session=${encodeURIComponent(JSON.stringify(session))}` : "";
      await worker.clients.openWindow(`/${hash}`);
    })(),
  );
});
