// Bundles the scripts browser access serves (src/browser-access) into out/browser-access.
// Pass --watch to rebuild on change during development.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  entryPoints: {
    client: path.join(desktopDir, "src/browser-access/client.ts"),
    bridge: path.join(desktopDir, "src/browser-access/bridge.ts"),
    "service-worker": path.join(desktopDir, "src/browser-access/service-worker.ts"),
  },
  outdir: path.join(desktopDir, "out/browser-access"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["safari16.4", "chrome120"],
  legalComments: "none",
  logLevel: "warning",
};

if (process.argv.includes("--watch")) {
  const watcher = await context(options);
  await watcher.watch();
} else {
  await build(options);
}
