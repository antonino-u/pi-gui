import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  type DesktopHarness,
} from "../helpers/electron-app";
import { startScriptedOpenAiServer } from "../helpers/scripted-openai-server";

const BROWSER_PROMPT = "Hello from a browser tab";
const BROWSER_REPLY = "The browser tab got this reply.";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** `fetch` cannot set the Host header, so this uses a raw request. */
async function statusWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, path: "/", headers: { Host: host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function readPairingToken(userDataDir: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(
        await readFile(join(userDataDir, "browser-access.json"), "utf8"),
      ) as { token?: string };
      if (parsed.token) return parsed.token;
    } catch {
      // The host writes the file while it starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The host never wrote its pairing token.");
}

/**
 * Opens the pairing link in a plain Chromium window without pi-gui's preload, which is
 * what a browser on another device gets: only the page, its cookie and its WebSocket.
 */
async function openBrowserTab(harness: DesktopHarness, pairingUrl: string): Promise<Page> {
  const origin = new URL(pairingUrl).origin;
  const opened = harness.electronApp.waitForEvent("window", {
    predicate: (page) => page.url() === `${origin}/`,
  });
  await harness.electronApp.evaluate(({ BrowserWindow }, url) => {
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Hidden windows throttle timers and frames, which a visible browser tab does not.
        backgroundThrottling: false,
      },
    });
    window.loadURL(url).catch(() => window.destroy());
  }, pairingUrl);
  const page = await opened;
  await page.waitForFunction(() => Boolean(globalThis.window.piApp));
  return page;
}

test("a browser tab drives pi-gui through its own window view", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspace = await makeWorkspace("browser-access");
  const server = await startScriptedOpenAiServer(() => ({ text: BROWSER_REPLY }));
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["scripted-test/scripted"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "scripted-test",
      defaultModel: "scripted",
      enabledModels: ["scripted-test/scripted"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "scripted-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "scripted" }],
        },
      },
    }),
  );
  const port = await freePort();
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: { PI_APP_BROWSER_ACCESS: `127.0.0.1:${port}` },
  });

  try {
    const desktop = await harness.firstWindow();
    const origin = `http://127.0.0.1:${port}`;
    const token = await readPairingToken(userDataDir);

    await test.step("an unpaired browser is refused", async () => {
      expect((await fetch(`${origin}/`)).status).toBe(403);
      expect((await fetch(`${origin}/__pi-browser/pair?token=wrong`)).status).toBe(403);
      expect(await statusWithHost(port, "attacker.example")).toBe(421);
    });

    await createNamedThread(desktop, "Desktop thread");
    const desktopBefore = await getDesktopState(desktop);
    const browser = await openBrowserTab(harness, `${origin}/__pi-browser/pair?token=${token}`);

    await test.step("the browser renders the app and runs a thread", async () => {
      await expect(browser.locator(".sidebar")).toContainText(basename(workspace));
      await createNamedThread(browser, "Browser thread");
      await browser.getByTestId("composer").fill(BROWSER_PROMPT);
      await browser.getByTestId("composer").press("Enter");
      await expect(browser.getByTestId("transcript")).toContainText(BROWSER_REPLY);
    });

    await test.step("the desktop window keeps its own selection", async () => {
      const desktopState = await getDesktopState(desktop);
      const browserState = await getDesktopState(browser);
      expect(desktopBefore.selectedSessionId).not.toBe("");
      expect(desktopState.selectedSessionId).toBe(desktopBefore.selectedSessionId);
      expect(browserState.selectedSessionId).not.toBe(desktopBefore.selectedSessionId);
      await expect(desktop.locator(".chat-header__title")).toHaveText("Desktop thread");
      const thread = desktopState.workspaces
        .flatMap((entry) => entry.sessions)
        .find((session) => session.title === "Browser thread");
      expect(thread).toBeDefined();
    });

    await test.step("host-only actions are refused in the browser", async () => {
      const message = await browser.evaluate(() =>
        globalThis.window.piApp.pickWorkspace().then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      );
      expect(message).toContain("not available in the browser");
    });
  } finally {
    await harness.close();
    await server.close();
  }
});
