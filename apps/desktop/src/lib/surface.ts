/**
 * True when the renderer runs on the host's own screen. A paired browser (on a phone or
 * another computer) cannot use Finder, editors or native pickers on the host, so controls
 * for those are hidden there.
 */
export function hasHostScreen(): boolean {
  return globalThis.window?.piApp?.surface !== "browser";
}
