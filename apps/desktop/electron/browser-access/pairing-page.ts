import { escapeAttribute } from "./browser-documents";
import { BROWSER_ACCESS_PREFIX } from "../../contracts/browser-access";

/**
 * The page an unpaired browser sees. It asks for the code pi-gui shows in Settings > Browser
 * access; a scanned pairing link fills the code in. Pairing happens only when the button is
 * tapped, so a link preview or a scanner's quick look does not pair its own browser.
 *
 * A Home Screen app keeps its own cookies, apart from Safari's, so it pairs by entering the
 * code inside the app itself.
 */
export function pairingPageHtml(
  options: { readonly error?: string; readonly code?: string } = {},
): string {
  const error = options.error
    ? `<p class="error" role="alert">${escapeAttribute(options.error)}</p>`
    : "";
  const code = options.code ? escapeAttribute(options.code.toUpperCase()) : "";
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
  p { color: color-mix(in srgb, CanvasText 70%, transparent); line-height: 1.45; margin: 0 0 16px; }
  form { display: grid; gap: 12px; margin-bottom: 20px; }
  input { font: inherit; font-size: 22px; letter-spacing: 0.2em; text-align: center; text-transform: uppercase;
    padding: 12px; border-radius: 12px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; color: inherit; }
  button { font: inherit; font-size: 16px; padding: 12px; border-radius: 12px; border: 0; background: CanvasText; color: Canvas; }
  .error { color: #d9534f; }
  .note { font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Pair with pi-gui</h1>
  <p>${
    code
      ? "Tap the button to pair this browser."
      : "On the computer running pi-gui, open Settings, then Browser access, and choose Pair a device. Enter the code it shows."
  }</p>
  ${error}
  <form method="get" action="${BROWSER_ACCESS_PREFIX}/pair">
    <input name="code" value="${code}" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="12" required aria-label="Pairing code" placeholder="ABCD 2345"${code ? "" : " autofocus"}>
    <input type="hidden" name="confirm" value="1">
    <button type="submit">Pair this device</button>
  </form>
  <p class="note">Opened from a scanner app? Open this page in Safari instead, so Safari is the browser that gets paired.</p>
  <p class="note">Using pi-gui from the Home Screen? It keeps its own sign-in, so enter the code there too. One code pairs up to four browsers within five minutes.</p>
</main>
</body>
</html>`;
}
