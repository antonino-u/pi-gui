import { BROWSER_ACCESS_PREFIX } from "../../contracts/browser-access";

/**
 * Documents the host writes for browsers. The scripts themselves are TypeScript in
 * `src/browser-access`, bundled into `out/browser-access` (scripts/build-browser-access.mjs).
 */

/** The bundled scripts and the paths the host serves them at. */
export const BROWSER_ACCESS_SCRIPTS = {
  client: { file: "client.js", path: `${BROWSER_ACCESS_PREFIX}/client.js` },
  bridge: { file: "bridge.js", path: `${BROWSER_ACCESS_PREFIX}/bridge.js` },
  serviceWorker: { file: "service-worker.js", path: `${BROWSER_ACCESS_PREFIX}/sw.js` },
} as const;

export type BrowserAccessScript = keyof typeof BROWSER_ACCESS_SCRIPTS;

/** Phones lay the app out edge to edge, under the notch and home indicator. */
const BROWSER_VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Adds the browser client and the Home Screen tags to the renderer's `index.html`. The client
 * script runs first, so `window.piApp` exists before the app bundle starts.
 */
export function browserIndexHtml(source: string, options: { readonly pushKey: string }): string {
  const html = source.replace(
    /<meta\s+name="viewport"[^>]*>/i,
    `<meta name="viewport" content="${BROWSER_VIEWPORT}" />`,
  );
  const tags = [
    `<script src="${BROWSER_ACCESS_SCRIPTS.client.path}" data-push-key="${escapeAttribute(options.pushKey)}"></script>`,
    `<link rel="manifest" href="${BROWSER_ACCESS_PREFIX}/manifest.webmanifest" crossorigin="use-credentials">`,
    `<link rel="apple-touch-icon" href="${BROWSER_ACCESS_PREFIX}/icon.png">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-title" content="pi">`,
    // The app draws under the status bar and pads its own background behind it (browser.css).
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
  ].join("");
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return tags + html;
  const end = head.index + head[0].length;
  return html.slice(0, end) + tags + html.slice(end);
}

/** The hidden bridge window's page: the real preload plus the bridge script. */
export function bridgeHtml(socketUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>pi-gui bridge</title></head><body><script src="${BROWSER_ACCESS_SCRIPTS.bridge.path}" data-socket="${escapeAttribute(socketUrl)}"></script></body></html>`;
}

/**
 * Web app manifest. A paired browser gets its own pairing link as the start URL: on iOS a Home
 * Screen app keeps its own cookies, so launching it pairs it again as the same device.
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
