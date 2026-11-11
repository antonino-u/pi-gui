import { escapeAttribute } from "./browser-documents";
import { BROWSER_ACCESS_PREFIX } from "../../contracts/browser-access";

/**
 * The page an unpaired browser sees. It asks for the one-time code that pi-gui shows in
 * Settings > Browser access, so a device can pair by visiting the address directly.
 */
export function pairingPageHtml(options: { readonly error?: string } = {}): string {
  const error = options.error
    ? `<p class="error" role="alert">${escapeAttribute(options.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Pair with pi-gui</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { width: min(360px, calc(100vw - 48px)); }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: color-mix(in srgb, CanvasText 70%, transparent); line-height: 1.45; margin: 0 0 20px; }
  form { display: grid; gap: 12px; }
  input { font: inherit; font-size: 22px; letter-spacing: 0.2em; text-align: center; text-transform: uppercase;
    padding: 12px; border-radius: 12px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; color: inherit; }
  button { font: inherit; font-size: 16px; padding: 12px; border-radius: 12px; border: 0; background: CanvasText; color: Canvas; }
  .error { color: #d9534f; margin: 0 0 12px; }
</style>
</head>
<body>
<main>
  <h1>Pair with pi-gui</h1>
  <p>On the computer running pi-gui, open Settings, then Browser access, and choose Pair a device. Enter the code it shows, or scan its QR code.</p>
  ${error}
  <form method="get" action="${BROWSER_ACCESS_PREFIX}/pair">
    <input name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="12" required aria-label="Pairing code" placeholder="ABCD 2345" autofocus>
    <button type="submit">Pair this device</button>
  </form>
</main>
</body>
</html>`;
}
