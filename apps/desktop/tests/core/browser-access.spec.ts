import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request, type Server } from "node:http";
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
import { readOptionalLog } from "../helpers/notification-events";
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

interface ReceivedPush {
  readonly authorization: string;
  readonly payload: { title?: string; body?: string; session?: unknown };
}

/** A push service on loopback that decrypts what it receives, as the browser would. */
async function startPushService(): Promise<{
  readonly endpoint: string;
  readonly subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  readonly received: ReceivedPush[];
  readonly close: () => Promise<void>;
}> {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = randomBytes(16);
  const received: ReceivedPush[] = [];
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  const server: Server = createHttpServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const salt = body.subarray(0, 16);
      const idLength = body[20] ?? 0;
      const senderPublic = body.subarray(21, 21 + idLength);
      const ciphertext = body.subarray(21 + idLength);
      const ikm = hmac(
        hmac(auth, receiver.computeSecret(senderPublic)),
        Buffer.concat([
          Buffer.from("WebPush: info\0"),
          receiver.getPublicKey(),
          senderPublic,
          Buffer.from([1]),
        ]),
      );
      const prk = hmac(salt, ikm);
      const decipher = createDecipheriv(
        "aes-128-gcm",
        hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16),
        hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12),
      );
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const padded = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ]);
      received.push({
        authorization: String(incoming.headers.authorization ?? ""),
        payload: JSON.parse(
          padded.subarray(0, padded.length - 1).toString("utf8"),
        ) as ReceivedPush["payload"],
      });
      response.writeHead(201);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const endpoint = `http://127.0.0.1:${port}/push/device-1`;
  return {
    endpoint,
    subscription: {
      endpoint,
      keys: {
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    },
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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
  const secondWorkspace = await makeWorkspace("browser-access-opened");
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
  const notificationLogPath = join(userDataDir, "notifications.log");
  const pushService = await startPushService();
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    notificationLogPath,
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
      const unpaired = await fetch(`${origin}/`, { redirect: "manual" });
      expect(unpaired.status).toBe(302);
      expect(unpaired.headers.get("location")).toBe("/__pi-browser/pair");
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

    await test.step("host-only actions are refused and hidden in the browser", async () => {
      const message = await browser.evaluate(() =>
        globalThis.window.piApp.openWorkspaceInFinder("any").then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      );
      expect(message).toContain("not available in the browser");
      expect(await browser.evaluate(() => document.documentElement.dataset.piSurface)).toBe(
        "browser",
      );
      expect(await browser.locator('meta[name="viewport"]').getAttribute("content")).toContain(
        "viewport-fit=cover",
      );
      await expect(desktop.getByTestId("open-in-editor")).toBeVisible();
      await expect(browser.getByTestId("open-in-editor")).toHaveCount(0);
    });

    await test.step("on a phone-width screen, a swipe from the left edge opens the menu", async () => {
      await harness.electronApp.evaluate(({ BrowserWindow }, url) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().startsWith(url))
          ?.setContentSize(390, 844);
      }, origin);
      await browser.waitForFunction(() => window.innerWidth <= 400);
      await browser.evaluate(() => globalThis.window.piApp.setSidebarCollapsed(true));
      await expect(browser.locator(".shell > .sidebar")).toHaveCount(0);
      const swipe = (points: readonly number[]) =>
        browser.evaluate(async (xs) => {
          const main = document.querySelector("main");
          if (!main) throw new Error("No main surface");
          const send = (type: string, x: number) => {
            const touch = new Touch({ identifier: 1, target: main, clientX: x, clientY: 400 });
            main.dispatchEvent(
              new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: type === "touchend" ? [] : [touch],
                changedTouches: [touch],
              }),
            );
          };
          send("touchstart", xs[0] ?? 0);
          for (const x of xs.slice(1)) {
            send("touchmove", x);
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          send("touchend", xs[xs.length - 1] ?? 0);
        }, points);
      // Starting mid-screen is a scroll, not a menu swipe.
      await swipe([150, 180, 240, 300]);
      await expect(browser.locator(".shell > .sidebar")).toHaveCount(0);
      await swipe([6, 40, 120, 220, 300]);
      await expect(browser.locator(".shell > .sidebar")).toBeVisible();
      await expect.poll(async () => (await getDesktopState(browser)).sidebarCollapsed).toBe(false);
      // The desktop window keeps its own sidebar.
      expect((await getDesktopState(desktop)).sidebarCollapsed).toBe(
        desktopBefore.sidebarCollapsed,
      );
    });

    await test.step("Open folder in the browser asks for a path on the host", async () => {
      const result = await browser.evaluate(async (folder) => {
        const answers = ["~/no-such-folder-for-this-test", folder];
        const alerts: string[] = [];
        window.prompt = () => answers.shift() ?? null;
        window.alert = (text?: unknown) => {
          alerts.push(String(text));
        };
        await globalThis.window.piApp.pickWorkspace();
        const state = await globalThis.window.piApp.pickWorkspace();
        return { alerts, paths: state.workspaces.map((entry) => entry.path) };
      }, secondWorkspace);
      expect(result.alerts).toEqual(["There is no folder at ~/no-such-folder-for-this-test."]);
      expect(result.paths).toContain(await realpath(secondWorkspace));
    });

    // A second tab speaks the wire protocol directly: Electron has no push service, so it
    // registers a subscription that points at the local push service.
    await browser.evaluate(async () => {
      const hex = () =>
        Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      const socket = new WebSocket(
        `ws://${location.host}/__pi-browser/socket?tab=${hex()}&instance=${hex()}`,
      );
      const waiting = new Map<number, (frame: { ok: boolean; v?: unknown; e?: string }) => void>();
      let nextId = 1;
      await new Promise<void>((resolve, reject) => {
        socket.onerror = () => reject(new Error("The second tab could not connect."));
        socket.onmessage = (message: MessageEvent<string>) => {
          const frame = JSON.parse(message.data) as { t: string; id?: number; ok: boolean };
          if (frame.t === "ready") resolve();
          if (frame.t === "result" && frame.id !== undefined) waiting.get(frame.id)?.(frame);
        };
      });
      const request = (t: "call" | "host", m: string, a: unknown[]) =>
        new Promise<unknown>((resolve, reject) => {
          const id = nextId++;
          waiting.set(id, (frame) => (frame.ok ? resolve(frame.v) : reject(new Error(frame.e))));
          socket.send(JSON.stringify({ t, id, m, a }));
        });
      Object.assign(globalThis, {
        secondTab: {
          request,
          setVisible: (visible: boolean) =>
            socket.send(JSON.stringify({ t: "visibility", visible })),
        },
      });
    });
    type SecondTab = {
      request: (t: "call" | "host", m: string, a: unknown[]) => Promise<unknown>;
      setVisible: (visible: boolean) => void;
    };
    const secondTabRequest = (t: "call" | "host", m: string, a: unknown[]) =>
      browser.evaluate(
        ([type, member, args]) =>
          (globalThis as unknown as { secondTab: SecondTab }).secondTab.request(type, member, args),
        [t, m, a] as const,
      );
    const setSecondTabVisible = (visible: boolean) =>
      browser.evaluate((value) => {
        (globalThis as unknown as { secondTab: SecondTab }).secondTab.setVisible(value);
      }, visible);
    const desktopRef = {
      workspaceId: desktopBefore.selectedWorkspaceId,
      sessionId: desktopBefore.selectedSessionId,
    };
    const notificationCount = async () =>
      (await readOptionalLog(notificationLogPath)).split("\n").filter(Boolean).length;
    const promptOnDesktop = async (text: string) => {
      await desktop.getByTestId("composer").fill(text);
      await desktop.getByTestId("composer").press("Enter");
    };

    await test.step("a subscribed browser is pushed when a thread finishes", async () => {
      expect(await secondTabRequest("host", "pushSubscribe", [pushService.subscription])).toBe(
        true,
      );
      await promptOnDesktop("First desktop prompt");
      await expect.poll(() => pushService.received.length).toBe(1);
      const [push] = pushService.received;
      expect(push?.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
      expect(push?.payload).toMatchObject({
        title: "Desktop thread",
        body: "Agent finished responding",
        session: desktopRef,
      });
    });

    await test.step("no push while an on-screen browser tab shows that thread", async () => {
      await secondTabRequest("call", "selectSession", [desktopRef]);
      await setSecondTabVisible(true);
      const before = await notificationCount();
      await promptOnDesktop("Second desktop prompt");
      await expect.poll(notificationCount).toBe(before + 1);
      await setSecondTabVisible(false);
      await promptOnDesktop("Third desktop prompt");
      // Pushes go out in order, so the third arriving second proves the second was skipped.
      await expect.poll(() => pushService.received.length).toBe(2);
      await expect.poll(notificationCount).toBe(before + 2);
    });

    await test.step("a thread muted from the browser sends no push until unmuted", async () => {
      const before = await notificationCount();
      await secondTabRequest("call", "setSessionNotificationsMuted", [desktopRef, true]);
      await promptOnDesktop("Muted desktop prompt");
      await secondTabRequest("call", "setSessionNotificationsMuted", [desktopRef, false]);
      await promptOnDesktop("Unmuted desktop prompt");
      // Pushes go out in order, so the third arriving after the unmute proves the muted one was skipped.
      await expect.poll(() => pushService.received.length).toBe(3);
      await expect.poll(notificationCount).toBe(before + 1);
    });

    await test.step("Settings pairs a device with a one-time code and revokes one", async () => {
      await desktop.evaluate(() => globalThis.window.piApp.setActiveView("settings"));
      await desktop.getByRole("button", { name: "Browser access" }).click();
      await expect(desktop.getByText("Paired devices", { exact: true })).toBeVisible();
      await desktop.getByRole("button", { name: "Pair a device" }).click();
      const code = (await desktop.getByTestId("browser-access-code").innerText()).replace(
        /\s/g,
        "",
      );
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
      await expect(desktop.locator(".browser-access-pairing__qr")).toBeVisible();

      const paired = await fetch(`${origin}/__pi-browser/pair?code=${code}`, {
        redirect: "manual",
      });
      expect(paired.status).toBe(302);
      const reused = await fetch(`${origin}/__pi-browser/pair?code=${code}`, {
        redirect: "manual",
      });
      expect(reused.status).toBe(403);
      await expect(desktop.getByTestId("browser-access-revoke")).toHaveCount(2);

      // Revoke the device whose tab is open: the tab leaves for the pairing page.
      await desktop.evaluate(() => {
        window.confirm = () => true;
      });
      await desktop
        .locator(".settings-row", { hasText: "Connected" })
        .getByTestId("browser-access-revoke")
        .click();
      await expect(desktop.getByTestId("browser-access-revoke")).toHaveCount(1);
      await expect.poll(() => new URL(browser.url()).pathname).toBe("/__pi-browser/pair");
    });
  } finally {
    await harness.close();
    await server.close();
    await pushService.close();
  }
});
